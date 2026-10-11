// psample: start a command, and each 2 ms read the instruction pointer of its main thread.
// At the end, write one line for each sample to out.txt: the time and the mapped file.
// sample_shares.py counts them. Usage: psample out.txt cmd [args…]
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/user.h>
#include <sys/wait.h>

typedef struct { unsigned long start, end; char path[256]; } Map;
static Map maps[20000]; static int nmaps;
static void read_maps(pid_t pid) {
  char p[64], line[1024]; snprintf(p, sizeof p, "/proc/%d/maps", pid);
  FILE *f = fopen(p, "r"); if (!f) return;
  nmaps = 0;
  while (fgets(line, sizeof line, f) && nmaps < 20000) {
    Map *m = &maps[nmaps]; char perms[8]; m->path[0] = 0;
    if (sscanf(line, "%lx-%lx %7s %*s %*s %*s %255[^\n]", &m->start, &m->end, perms, m->path) >= 3) nmaps++;
  }
  fclose(f);
}
typedef struct { double t; unsigned long ip; } Sample;
static Sample *samples; static long ns, cap;
static double now(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec + ts.tv_nsec / 1e9; }

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  pid_t pid = fork();
  if (pid == 0) { ptrace(PTRACE_TRACEME, 0, 0, 0); raise(SIGSTOP); execvp(argv[2], argv + 2); _exit(127); }
  int st; waitpid(pid, &st, 0); ptrace(PTRACE_CONT, pid, 0, 0);
  waitpid(pid, &st, 0); /* the exec stop */ ptrace(PTRACE_CONT, pid, 0, 0);
  cap = 1 << 20; samples = malloc(cap * sizeof(Sample));
  struct timespec nap = { 0, 2000000 };
  for (long i = 0;; i++) {
    nanosleep(&nap, NULL);
    if (syscall(SYS_tgkill, pid, pid, SIGSTOP) != 0) break;
    if (waitpid(pid, &st, 0) < 0 || WIFEXITED(st) || WIFSIGNALED(st)) break;
    int sig = WSTOPSIG(st);
    if (sig == SIGSTOP) {
      struct user_regs_struct r;
      if (ptrace(PTRACE_GETREGS, pid, 0, &r) == 0 && ns < cap) { samples[ns].t = now(); samples[ns].ip = r.rip; ns++; }
      if (i % 250 == 0) read_maps(pid);
      ptrace(PTRACE_CONT, pid, 0, 0);
    } else {
      ptrace(PTRACE_CONT, pid, 0, sig == SIGTRAP ? 0 : sig);
    }
  }
  FILE *out = fopen(argv[1], "w");
  for (long i = 0; i < ns; i++) {
    const char *path = "?";
    for (int m = 0; m < nmaps; m++) if (samples[i].ip >= maps[m].start && samples[i].ip < maps[m].end) { path = maps[m].path[0] ? maps[m].path : "[anon]"; break; }
    fprintf(out, "%.6f %s\n", samples[i].t, path);
  }
  fclose(out);
  return 0;
}
