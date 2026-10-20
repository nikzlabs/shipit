// gl-call-times: an LD_PRELOAD library for a Chromium on Mesa. It writes one line for each OpenGL call
// that takes GLTIME_SLOW_MS or more (default 5; GLTIME_ALL=1 writes each call), with the call's integer
// arguments. From 50 ms it adds the thread's user time, system time and page faults during the call.
// The file is $GLTIME_DIR/gltime.<pid>.log (default /tmp), one for each process that makes such calls.
//
// ANGLE finds eglGetProcAddress with dlsym on the library's handle, which a preloaded symbol of that name
// does not catch, so this library wraps dlsym. It also keeps the process open to a debugger of the same
// user: Chromium gives the one PR_SET_PTRACER place to its crash handler.
// Build: gcc -O1 -fPIC -shared -o gl-call-times.so gl-call-times.c -ldl
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static const char *NAMES[] = {
  "glClear", "glClearBufferfv", "glClearBufferiv", "glClearBufferuiv", "glTexStorage3D", "glTexImage3D",
  "glTexSubImage3D", "glTexStorage2D", "glTexImage2D", "glTexSubImage2D", "glFramebufferTextureLayer", "glFramebufferTexture2D",
  "glCheckFramebufferStatus", "glBindFramebuffer", "glFlush", "glFinish", "glReadPixels", "glFenceSync", "glClientWaitSync",
  "glLinkProgram", "glCompileShader", "glDrawArrays", "glDrawElements", "glBlitFramebuffer", "glGenerateMipmap", "glBufferData",
  "glBufferSubData", "glMapBufferRange", "glUnmapBuffer", "glCopyTexSubImage3D", "glCopyTexSubImage2D", "glGetProgramiv",
  "glGetShaderiv", "glDrawElementsInstanced", "glDrawArraysInstanced", "glDeleteTextures", "glGetError", 0,
};
#define MAX_WRAPPED 48

// A call passes through with its integer and pointer arguments only. The wrapper does not keep the
// floating-point registers, so NAMES must not have a function that takes a float or a double.
typedef uint64_t (*Fn)(uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t);
static struct { const char *name; Fn real; } wrapped[MAX_WRAPPED];
static int wrapped_count;
static FILE *log_file;
static double slow_ms = 5.0, start_ms;
static int log_all;

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}
static double ms(struct timeval a, struct timeval b) { return (b.tv_sec - a.tv_sec) * 1e3 + (b.tv_usec - a.tv_usec) / 1e3; }

static void open_log(void) {
  if (log_file) return;
  char path[256];
  const char *dir = getenv("GLTIME_DIR"), *slow = getenv("GLTIME_SLOW_MS");
  snprintf(path, sizeof path, "%s/gltime.%d.log", dir ? dir : "/tmp", getpid());
  log_file = fopen(path, "w");
  if (!log_file) log_file = stderr;
  setvbuf(log_file, NULL, _IOLBF, 0);
  if (slow) slow_ms = atof(slow);
  log_all = getenv("GLTIME_ALL") != NULL;
  start_ms = now_ms();
}

static uint64_t timed(int i, uint64_t a, uint64_t b, uint64_t c, uint64_t d, uint64_t e, uint64_t f, uint64_t g, uint64_t h, uint64_t j, uint64_t k, uint64_t l, uint64_t m) {
  struct rusage before, after;
  getrusage(RUSAGE_THREAD, &before);
  double t = now_ms();
  uint64_t result = wrapped[i].real(a, b, c, d, e, f, g, h, j, k, l, m);
  double took = now_ms() - t;
  if (took >= slow_ms || log_all) {
    fprintf(log_file, "%10.1f %s(%d,%d,%d,%d,%d,%d,%d,%d,%d,%d) %.2f ms\n", t - start_ms, wrapped[i].name,
            (int)a, (int)b, (int)c, (int)d, (int)e, (int)f, (int)g, (int)h, (int)j, (int)k, took);
  }
  if (took >= 50) {
    getrusage(RUSAGE_THREAD, &after);
    fprintf(log_file, "           %s: user %.0f ms, system %.0f ms, page faults %ld minor %ld major\n", wrapped[i].name,
            ms(before.ru_utime, after.ru_utime), ms(before.ru_stime, after.ru_stime), after.ru_minflt - before.ru_minflt, after.ru_majflt - before.ru_majflt);
  }
  return result;
}

// The two digits of a wrapper's name are its place in `wrappers`, in octal.
#define W(i) static uint64_t w##i(uint64_t a, uint64_t b, uint64_t c, uint64_t d, uint64_t e, uint64_t f, uint64_t g, uint64_t h, uint64_t j, uint64_t k, uint64_t l, uint64_t m) { return timed(0##i, a, b, c, d, e, f, g, h, j, k, l, m); }
#define W8(n) W(n##0) W(n##1) W(n##2) W(n##3) W(n##4) W(n##5) W(n##6) W(n##7)
W8(0) W8(1) W8(2) W8(3) W8(4) W8(5)
#define R8(n) w##n##0, w##n##1, w##n##2, w##n##3, w##n##4, w##n##5, w##n##6, w##n##7
static Fn wrappers[MAX_WRAPPED] = { R8(0), R8(1), R8(2), R8(3), R8(4), R8(5) };

static void *(*real_get_proc)(const char *);
static void *get_proc(const char *name) {
  void *real = real_get_proc(name);
  if (!real) return real;
  open_log();
  for (int n = 0; NAMES[n]; n++) {
    if (strcmp(NAMES[n], name)) continue;
    int i = 0;
    while (i < wrapped_count && strcmp(wrapped[i].name, name)) i++;
    if (i == wrapped_count) {
      if (wrapped_count == MAX_WRAPPED) return real;
      wrapped[i].name = NAMES[n];
      wrapped[i].real = (Fn)real;
      wrapped_count++;
    }
    return (void *)wrappers[i];
  }
  return real;
}

void *dlsym(void *handle, const char *name) {
  static void *(*real_dlsym)(void *, const char *);
  if (!real_dlsym) real_dlsym = dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.34");
  if (!real_dlsym) real_dlsym = dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.2.5");
  void *real = real_dlsym(handle, name);
  if (real && !strcmp(name, "eglGetProcAddress")) {
    real_get_proc = real;
    return (void *)get_proc;
  }
  return real;
}

__attribute__((constructor)) static void allow_debugger(void) { syscall(SYS_prctl, PR_SET_PTRACER, PR_SET_PTRACER_ANY, 0, 0, 0); }

int prctl(int option, ...) {
  va_list args;
  va_start(args, option);
  unsigned long a = va_arg(args, unsigned long), b = va_arg(args, unsigned long), c = va_arg(args, unsigned long), d = va_arg(args, unsigned long);
  va_end(args);
  if (option == PR_SET_PTRACER) a = PR_SET_PTRACER_ANY;
  if (option == PR_SET_DUMPABLE) a = 1;
  return syscall(SYS_prctl, option, a, b, c, d);
}
