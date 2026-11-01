import sys, json
for line in open(sys.argv[1]):
    line=line.strip()
    if line.startswith('##'): print(line); continue
    try: r=json.loads(line)
    except Exception: print('  ?', line[:300]); continue
    if 'step' not in r: print('  ', line[:300]); continue
    card=r.get('cardUse') or {}
    print('  %-22s %-6s grp %3s drw %2s %-5s %-4s n %3s %5s MB  link %6s ms (%5s ms/prog)  draw %6s ms  failed %s glErr %s  gpuCPU %5s s wall %5s s  link frames %4s gap %5s ms round %5s call %5s ms  draw frames %4s gap %5s ms  load %s card %s%%  %s' % (
        r.get('step'), r.get('mode'), r.get('group', '-'), r.get('drawGroup', 0), r.get('pairSet', 'all'), 'anim' if r.get('animate') else '', r.get('n'), r.get('sourceMB', '?'),
        r.get('linkMs'), r.get('perProgramMs'), r.get('firstDrawMs'), r.get('failed'), r.get('glError'), r.get('gpuProcCpuS'), r.get('wallS'),
        r.get('framesDuringLink'), r.get('maxFrameGapMs'), r.get('longestPollMs', '-'), r.get('longestCallMs', '-'), r.get('framesDuringDraw', '-'), r.get('maxDrawGapMs', '-'),
        r.get('loadavg', '-'), '%s-%s-%s' % (card.get('min'), card.get('mean'), card.get('max')) if card else '-', (r.get('renderer') or r.get('error') or '')[7:60]))
