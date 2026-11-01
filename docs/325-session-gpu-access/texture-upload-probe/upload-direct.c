// upload-direct: Mesa with no browser. It makes the uploads of the WebGL probe through EGL and
// OpenGL ES 3, and it times copy methods into the memory that Mesa maps for a buffer.
// It needs no Mesa headers: the functions come from libEGL.so.1 and eglGetProcAddress.
// Build: gcc -O2 -o upload-direct upload-direct.c -ldl
// Usage: upload-direct [all|array|2d|copy] [layers]
#define _GNU_SOURCE
#include <dlfcn.h>
#include <immintrin.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef void *EGLDisplay, *EGLConfig, *EGLContext, *EGLSurface;
typedef int EGLint, GLint, GLsizei;
typedef unsigned EGLBoolean, EGLenum, GLenum, GLuint, GLbitfield;
typedef long GLsizeiptr, GLintptr;

#define EGL_PLATFORM_SURFACELESS_MESA 0x31DD
#define EGL_OPENGL_ES_API 0x30A0
#define GL_TEXTURE_2D 0x0DE1
#define GL_TEXTURE_2D_ARRAY 0x8C1A
#define GL_RGBA8 0x8058
#define GL_RGBA 0x1908
#define GL_UNSIGNED_BYTE 0x1401
#define GL_RENDERER 0x1F01
#define GL_VERSION 0x1F02
#define GL_ARRAY_BUFFER 0x8892
#define GL_PIXEL_UNPACK_BUFFER 0x88EC
#define GL_STREAM_DRAW 0x88E0
#define GL_MAP_WRITE_BIT 0x0002
#define GL_MAP_INVALIDATE_BUFFER_BIT 0x0008

#define FUNCTIONS(F) \
  F(EGLDisplay, eglGetPlatformDisplay, (EGLenum, void *, const long *)) \
  F(EGLBoolean, eglInitialize, (EGLDisplay, EGLint *, EGLint *)) \
  F(EGLBoolean, eglChooseConfig, (EGLDisplay, const EGLint *, EGLConfig *, EGLint, EGLint *)) \
  F(EGLBoolean, eglBindAPI, (EGLenum)) \
  F(EGLContext, eglCreateContext, (EGLDisplay, EGLConfig, EGLContext, const EGLint *)) \
  F(EGLBoolean, eglMakeCurrent, (EGLDisplay, EGLSurface, EGLSurface, EGLContext)) \
  F(const char *, glGetString, (GLenum)) \
  F(void, glGenTextures, (GLsizei, GLuint *)) \
  F(void, glBindTexture, (GLenum, GLuint)) \
  F(void, glDeleteTextures, (GLsizei, const GLuint *)) \
  F(void, glTexStorage3D, (GLenum, GLsizei, GLenum, GLsizei, GLsizei, GLsizei)) \
  F(void, glTexStorage2D, (GLenum, GLsizei, GLenum, GLsizei, GLsizei)) \
  F(void, glTexSubImage3D, (GLenum, GLint, GLint, GLint, GLint, GLsizei, GLsizei, GLsizei, GLenum, GLenum, const void *)) \
  F(void, glTexSubImage2D, (GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, const void *)) \
  F(void, glFinish, (void)) \
  F(GLenum, glGetError, (void)) \
  F(void, glGenBuffers, (GLsizei, GLuint *)) \
  F(void, glBindBuffer, (GLenum, GLuint)) \
  F(void, glBufferData, (GLenum, GLsizeiptr, const void *, GLenum)) \
  F(void *, glMapBufferRange, (GLenum, GLintptr, GLsizeiptr, GLbitfield)) \
  F(unsigned char, glUnmapBuffer, (GLenum))
#define DECLARE(ret, name, args) static ret (*name) args;
FUNCTIONS(DECLARE)

static void *egl;
static void *(*get_proc)(const char *);
static void *sym(const char *name) {
  void *p = dlsym(egl, name);
  if (!p) p = get_proc(name);
  if (!p) { fprintf(stderr, "missing %s\n", name); exit(1); }
  return p;
}

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}
static const char *pressure(void) {
  static char line[200];
  FILE *f = fopen("/proc/pressure/cpu", "r");
  line[0] = 0;
  if (f) { if (fgets(line, sizeof line, f)) line[strcspn(line, "\n")] = 0; fclose(f); }
  return line;
}

typedef void (*Copy)(void *, const void *, size_t);
static void copy_libc(void *d, const void *s, size_t n) { memcpy(d, s, n); }
static void copy_movsb(void *d, const void *s, size_t n) { __asm__ volatile("rep movsb" : "+D"(d), "+S"(s), "+c"(n) : : "memory"); }
__attribute__((target("avx2"))) static void copy_avx(void *d, const void *s, size_t n) {
  for (size_t i = 0; i + 32 <= n; i += 32) _mm256_storeu_si256((__m256i *)((char *)d + i), _mm256_loadu_si256((const __m256i *)((const char *)s + i)));
}
__attribute__((target("avx2"))) static void copy_stream(void *d, const void *s, size_t n) {
  for (size_t i = 0; i + 32 <= n; i += 32) _mm256_stream_si256((__m256i *)((char *)d + i), _mm256_loadu_si256((const __m256i *)((const char *)s + i)));
  _mm_sfence();
}
static void fill_libc(void *d, const void *s, size_t n) { (void)s; memset(d, 0, n); }
static void fill_stosb(void *d, const void *s, size_t n) { (void)s; __asm__ volatile("rep stosb" : "+D"(d), "+c"(n) : "a"(0) : "memory"); }

// MB each second for copies of `chunk` bytes over a window of `span` bytes: 300 ms, or 64 MB if that is sooner.
static double speed(Copy copy, char *dst, const char *src, size_t chunk, size_t span) {
  double start = now(), elapsed;
  size_t done = 0, offset = 0;
  do {
    copy(dst + offset, src + offset, chunk);
    done += chunk;
    offset += chunk;
    if (offset + chunk > span) offset = 0;
    elapsed = now() - start;
  } while (elapsed < 300 && done < (64u << 20));
  return (done / 1048576.0) / (elapsed / 1e3);
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "all";
  int layers = argc > 2 ? atoi(argv[2]) : 145;
  const int S = 256;
#define MODE(name) (!strcmp(mode, "all") || !strcmp(mode, name))

  egl = dlopen("libEGL.so.1", RTLD_NOW | RTLD_GLOBAL);
  if (!egl) { fprintf(stderr, "%s\n", dlerror()); return 1; }
  get_proc = dlsym(egl, "eglGetProcAddress");
#define LOAD(ret, name, args) name = sym(#name);
  FUNCTIONS(LOAD)

  EGLDisplay display = eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, NULL, NULL);
  EGLint major, minor, count = 0;
  if (!eglInitialize(display, &major, &minor)) { fprintf(stderr, "eglInitialize failed\n"); return 1; }
  eglBindAPI(EGL_OPENGL_ES_API);
  // EGL_RENDERABLE_TYPE = EGL_OPENGL_ES3_BIT, EGL_SURFACE_TYPE = EGL_PBUFFER_BIT; then EGL_CONTEXT_MAJOR_VERSION = 3.
  EGLint config_attribs[] = { 0x3040, 0x0040, 0x3033, 0x0001, 0x3038 }, context_attribs[] = { 0x3098, 3, 0x3038 };
  EGLConfig config;
  eglChooseConfig(display, config_attribs, &config, 1, &count);
  EGLContext context = eglCreateContext(display, config, NULL, context_attribs);
  if (!context || !eglMakeCurrent(display, NULL, NULL, context)) { fprintf(stderr, "no context\n"); return 1; }

  const char *tunables = getenv("GLIBC_TUNABLES");
  printf("renderer: %s | %s\ncpu pressure: %s\nGLIBC_TUNABLES=%s\n", glGetString(GL_RENDERER), glGetString(GL_VERSION), pressure(), tunables ? tunables : "");

  size_t bytes = (size_t)S * S * layers * 4;
  unsigned char *data = malloc(bytes);
  memset(data, 200, bytes);
  GLuint texture;
  double t0, t1, t2, t3;

  if (MODE("array")) {
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D_ARRAY, texture);
    glFinish();
    t0 = now();
    glTexStorage3D(GL_TEXTURE_2D_ARRAY, 1, GL_RGBA8, S, S, layers);
    t1 = now();
    glTexSubImage3D(GL_TEXTURE_2D_ARRAY, 0, 0, 0, 0, S, S, layers, GL_RGBA, GL_UNSIGNED_BYTE, data);
    t2 = now();
    glFinish();
    t3 = now();
    printf("2D array %dx%dx%d RGBA8 (%.1f MB): texStorage3D %.1f ms, texSubImage3D %.1f ms, finish %.1f ms, total %.1f ms, glError 0x%x\n",
           S, S, layers, bytes / 1048576.0, t1 - t0, t2 - t1, t3 - t2, t3 - t0, glGetError());
    glDeleteTextures(1, &texture);
  }

  if (MODE("2d")) {
    int W = 4096, H = (int)(bytes / 4 / W);
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    glFinish();
    t0 = now();
    glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, W, H);
    t1 = now();
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, data);
    t2 = now();
    glFinish();
    t3 = now();
    printf("one 2D %dx%d RGBA8 (%.1f MB): texStorage2D %.1f ms, texSubImage2D %.1f ms, finish %.1f ms, total %.1f ms, glError 0x%x\n",
           W, H, (double)W * H * 4 / 1048576, t1 - t0, t2 - t1, t3 - t2, t3 - t0, glGetError());
    glDeleteTextures(1, &texture);

    GLuint *textures = malloc(sizeof(GLuint) * layers);
    glGenTextures(layers, textures);
    glFinish();
    t0 = now();
    for (int i = 0; i < layers; i++) {
      glBindTexture(GL_TEXTURE_2D, textures[i]);
      glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, S, S);
      glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, S, S, GL_RGBA, GL_UNSIGNED_BYTE, data + (size_t)i * S * S * 4);
    }
    t1 = now();
    glFinish();
    t2 = now();
    printf("%d separate 2D %dx%d RGBA8: uploads %.1f ms, finish %.1f ms, total %.1f ms, glError 0x%x\n", layers, S, S, t1 - t0, t2 - t1, t2 - t0, glGetError());
    glDeleteTextures(layers, textures);
  }

  if (MODE("copy")) {
    size_t span = 40u << 20;
    char *heap = aligned_alloc(4096, span), *src = aligned_alloc(4096, span);
    memset(heap, 1, span);
    memset(src, 200, span);
    // Mesa 22.3.6: a STREAM_DRAW array buffer is PIPE_USAGE_STREAM, a Direct3D 12 upload heap, which is also what a
    // texture upload maps (d3d12_resource.cpp). A pixel unpack buffer is PIPE_USAGE_STAGING, a read-back heap.
    struct { const char *name; GLenum target; } kinds[] = {
      { "ARRAY_BUFFER, STREAM_DRAW: Direct3D 12 upload heap", GL_ARRAY_BUFFER },
      { "PIXEL_UNPACK_BUFFER: Direct3D 12 read-back heap", GL_PIXEL_UNPACK_BUFFER },
      { "malloc memory, no GPU", 0 },
    };
    size_t chunks[] = { 1024, 2048, 4096, 8192, 65536, 262144, 524288, 1048576, 4194304 };
    for (int k = 0; k < 3; k++) {
      char *dst = heap;
      GLuint buffer = 0;
      if (kinds[k].target) {
        glGenBuffers(1, &buffer);
        glBindBuffer(kinds[k].target, buffer);
        glBufferData(kinds[k].target, span, NULL, GL_STREAM_DRAW);
        dst = glMapBufferRange(kinds[k].target, 0, span, GL_MAP_WRITE_BIT | GL_MAP_INVALIDATE_BUFFER_BIT);
        if (!dst) { printf("map failed, glError 0x%x\n", glGetError()); continue; }
      }
      printf("\ndestination: %s | cpu pressure: %s\n%-11s %12s %12s %12s %12s %12s %12s   (MB/s)\n", kinds[k].name, pressure(),
             "chunk bytes", "libc memcpy", "rep movsb", "AVX2 stores", "AVX2 stream", "libc memset", "rep stosb");
      for (unsigned i = 0; i < sizeof chunks / sizeof *chunks; i++) {
        size_t chunk = chunks[i];
        printf("%-11zu %12.0f %12.0f %12.0f %12.0f %12.0f %12.0f\n", chunk, speed(copy_libc, dst, src, chunk, span), speed(copy_movsb, dst, src, chunk, span),
               speed(copy_avx, dst, src, chunk, span), speed(copy_stream, dst, src, chunk, span), speed(fill_libc, dst, src, chunk, span), speed(fill_stosb, dst, src, chunk, span));
      }
      if (kinds[k].target) glUnmapBuffer(kinds[k].target);
    }
  }
  return 0;
}
