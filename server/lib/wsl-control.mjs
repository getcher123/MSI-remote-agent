// Small scoped WSL process-group adapter. It does not start a daemon or inspect Codex.
// The child identifies itself before exec, so the marker cannot mix with its output.
export const WSL_LAUNCH = String.raw`
import json, os, subprocess, sys
nonce = sys.argv[1]
command = sys.argv[2:]
if not command:
    raise SystemExit(64)
inner = r'''
import json, os, sys
pid = os.getpid()
stat = open('/proc/self/stat', encoding='utf-8').read().rsplit(')', 1)[1].split()
identity = {'pid': pid, 'pgid': os.getpgrp(), 'uid': os.getuid(), 'start_time': stat[19]}
sys.stderr.write('__AIHUB_WSL_' + sys.argv[1] + '__' + json.dumps(identity) + '\n')
sys.stderr.flush()
os.execvp(sys.argv[2], sys.argv[2:])
'''
child = subprocess.Popen([sys.executable, '-u', '-c', inner, nonce, *command], start_new_session=True)
code = child.wait()
raise SystemExit(code if code >= 0 else 128 - code)
`;

export const WSL_SIGNAL = String.raw`
import json, os, signal, sys
pid, uid = int(sys.argv[1]), int(sys.argv[2])
started, name = sys.argv[3], sys.argv[4]
if pid <= 1 or uid != os.getuid() or name not in ('TERM', 'KILL', 'PROBE'):
    raise SystemExit(64)
if name == 'PROBE':
    members = []
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit():
            continue
        try:
            st = os.stat(entry.path)
            fields = open(entry.path + '/stat', encoding='utf-8').read().rsplit(')', 1)[1].split()
            if st.st_uid == uid and int(fields[2]) == pid and int(fields[3]) == pid and fields[0] != 'Z':
                members.append(int(entry.name))
        except (OSError, ValueError, IndexError):
            pass
    print(json.dumps({'group_absent': not members, 'live_members': len(members)}))
else:
    try:
        st = os.stat('/proc/' + str(pid))
        fields = open('/proc/' + str(pid) + '/stat', encoding='utf-8').read().rsplit(')', 1)[1].split()
    except FileNotFoundError:
        print(json.dumps({'sent': False, 'reason': 'leader_already_absent'}))
        raise SystemExit(0)
    if st.st_uid != uid or fields[19] != started or int(fields[2]) != pid or int(fields[3]) != pid:
        print(json.dumps({'sent': False, 'reason': 'process_identity_mismatch'}))
        raise SystemExit(0)
    os.killpg(pid, signal.SIGKILL if name == 'KILL' else signal.SIGTERM)
    print(json.dumps({'sent': True, 'scope': 'wsl_process_group'}))
`;
