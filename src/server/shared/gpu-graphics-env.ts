/**
 * Keeps glibc's `memcpy` off `rep movsb` in a process that draws through Mesa's Direct3D 12 driver.
 * On the measured host that instruction wrote the card's upload memory about 40 times slower than
 * the vector loop that replaces it (docs/325-session-gpu-access req 12).
 */
export const GPU_GRAPHICS_GLIBC_TUNABLES = "glibc.cpu.x86_rep_movsb_threshold=0x40000000";

export const GLIBC_TUNABLES_ENV = "GLIBC_TUNABLES";
