#!/usr/bin/env python3
"""Drive the interactive TUI in a pseudo-terminal and print the rendered screen.

Usage: tui.py <cwd> <step> [<step> ...]
A step is either "wait:<seconds>", "until:<text>" (wait up to 120s for text on screen),
"snap" (print the screen), "full" (scrollback + screen), "shot:<file.png>" (save the
screen as an image), or keys to type. Keys may contain the escapes
<enter> <esc> <tab> <stab> <up> <down> <left> <right> <ctrl-c> <ctrl-u> <bs>.
snap, full and shot first wait for the screen to settle, so they never show half a frame.
"""
import os, pty, select, sys, time, signal
RAW = open(os.environ['RAW_LOG'], 'wb') if os.environ.get('RAW_LOG') else None
import pyte

COLS, ROWS = int(os.environ.get('TUI_COLS', 110)), int(os.environ.get('TUI_ROWS', 50))
KEYS = {'<enter>': '\r', '<esc>': '\x1b', '<tab>': '\t', '<stab>': '\x1b[Z', '<up>': '\x1b[A',
        '<down>': '\x1b[B', '<right>': '\x1b[C', '<left>': '\x1b[D', '<ctrl-c>': '\x03', '<ctrl-u>': '\x15', '<bs>': '\x7f'}
CLI = os.environ.get('ZOI_CLI') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dist', 'cli.js')

screen = pyte.HistoryScreen(COLS, ROWS, history=2000)
stream = pyte.ByteStream(screen)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(sys.argv[1])
    os.environ.update(TERM='xterm-256color', COLUMNS=str(COLS), LINES=str(ROWS), FORCE_COLOR='3')
    # This is an interactive terminal even on a CI runner: with CI set, Ink prints only the final frame.
    for k in ('CI', 'CONTINUOUS_INTEGRATION'):
        os.environ.pop(k, None)
    if os.environ.get('ZOI_TEST_HOME'):
        # Keep test runs from touching the real ~/.zoicode.
        os.makedirs(os.environ['ZOI_TEST_HOME'], exist_ok=True)
        os.environ['HOME'] = os.environ['ZOI_TEST_HOME']
    os.execvp('node', ['node', CLI] + os.environ.get('ZOI_ARGS', '').split())

import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))

def read_once(timeout):
    """Feeds the app's next output to the screen: None if there was none, False once it has exited."""
    r, _, _ = select.select([fd], [], [], timeout)
    if not r:
        return None
    try:
        data = os.read(fd, 65536)
    except OSError:
        return False
    if not data:
        return False
    stream.feed(data)
    if RAW: RAW.write(data); RAW.flush()
    return True

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        if read_once(0.05) is False:
            return False
    return True

def settle(quiet=0.3, limit=3.0):
    """Waits until the app has written nothing for `quiet` seconds (or `limit` passes)."""
    end = time.time() + limit
    while time.time() < end:
        got = read_once(quiet)
        if got is not True:
            return got is None
    return True

def text():
    return '\n'.join(line.rstrip() for line in screen.display)

def snap(label=''):
    print(f'===== screen {label} =====')
    print('\n'.join(l for l in text().split('\n')).rstrip())

def full():
    """Scrollback plus the visible screen."""
    print('===== scrollback + screen =====')
    for line in screen.history.top:
        print(''.join(line[x].data for x in range(COLS)).rstrip())
    print(text().rstrip())

def type_keys(s):
    i = 0
    while i < len(s):
        for k, v in KEYS.items():
            if s.startswith(k, i):
                os.write(fd, v.encode()); i += len(k); break
        else:
            os.write(fd, s[i].encode()); i += 1
        pump(float(os.environ.get('KEY_DELAY', '0.02')))

alive = True
for step in sys.argv[2:]:
    if not alive:
        break
    if step.startswith('wait:'):
        alive = pump(float(step[5:]))
    elif step.startswith('until:'):
        target, end = step[6:], time.time() + 120
        while alive and target not in text() and time.time() < end:
            alive = pump(0.2)
        if target not in text():
            print(f'!! timed out waiting for {target!r}')
    elif step == 'snap':
        alive = settle()
        snap()
    elif step == 'full':
        alive = settle()
        full()
    elif step.startswith('shot:'):
        alive = settle()
        # Save the visible screen as a PNG, colors and all.
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import termshot
        print('shot:', termshot.render(screen, step[5:], light=bool(os.environ.get('TUI_LIGHT'))))
    else:
        type_keys(step)
pump(0.5)
settle()
snap('final')
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
