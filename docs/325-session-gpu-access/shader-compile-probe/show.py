import sys, json
for line in open(sys.argv[1]):
    line=line.strip()
    if line.startswith('##'): print(line); continue
    try: r=json.loads(line)
    except Exception: print('  ?', line[:300]); continue
    print('  %-22s link %6s ms (%5s ms/prog)  draw %6s ms  failed %s glErr %s  gpuCPU %5s s wall %5s s  gap %5s ms frames %4s par=%s  %s' % (r.get('step'), r.get('linkMs'), r.get('perProgramMs'), r.get('firstDrawMs'), r.get('failed'), r.get('glError'), r.get('gpuProcCpuS'), r.get('wallS'), r.get('maxFrameGapMs'), r.get('framesDuringLink'), r.get('parallelExt'), (r.get('renderer') or r.get('error') or '')[7:60]))
