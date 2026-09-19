# Running ROOT-A-TRON 3000 on Linux

Everything is one command:

```sh
./start
```

It builds the Docker image if needed, starts the server, waits for it, and
opens <http://localhost:8000>. Press Ctrl-C to stop. The rest of this page is
for getting to that point, and for when it doesn't work.

---

## 1. Install Docker

Pick your distribution. Any reasonably recent Docker Engine will do.

**Ubuntu / Debian**

```sh
sudo apt update
sudo apt install -y docker.io
sudo systemctl enable --now docker
```

**Fedora / RHEL / Rocky / Alma**

```sh
sudo dnf install -y docker
sudo systemctl enable --now docker
```

**Arch / Manjaro**

```sh
sudo pacman -S docker
sudo systemctl enable --now docker
```

**openSUSE**

```sh
sudo zypper install docker
sudo systemctl enable --now docker
```

Check it:

```sh
docker --version
```

> **Using Podman instead?** It works. Skip step 2 (rootless Podman needs no
> group) and start the tool with `ROOTFIT_DOCKER=podman ./start`.

---

## 2. Let your user run Docker without sudo

By default only root can talk to the Docker daemon, and `./start` will stop
with a "not allowed to talk to it" message. Fix it once:

```sh
sudo usermod -aG docker "$USER"
```

Then **log out and back in** — group membership is only picked up on login. To
use it immediately in the current terminal instead:

```sh
newgrp docker
```

Verify:

```sh
docker run --rm hello-world
```

If that prints a greeting without `sudo`, you're set.

---

## 3. Start the tool

From the repository folder:

```sh
./start
```

On the first run it will:

1. check that Docker is installed and running,
2. build the `rootfit-backend` image — this downloads the CERN ROOT base image,
   **several GB, so expect 5–20 minutes** depending on your connection,
3. start the container and wait for the server to answer,
4. open <http://localhost:8000> in your browser.

Later runs skip the build and take a few seconds.

The terminal stays open showing the server log. **Ctrl-C stops the container**
and cleans up. Closing the terminal window does the same.

---

## 4. One button instead of one command

Register a launcher in your applications menu:

```sh
./start --install-desktop
```

"ROOT-A-TRON 3000" now appears alongside your other applications, and
launching it runs `./start` in a terminal window. This writes a single file:

```
~/.local/share/applications/rootatron3000.desktop
```

Delete that file to remove the launcher. If you move the repository folder, run
`--install-desktop` again — the entry records an absolute path.

> The launcher opens a terminal window, because that window is how you read the
> log and how you stop the server. It needs a terminal emulator your desktop
> knows about, which every mainstream desktop environment provides. On a very
> minimal window manager it may do nothing; use `./start` directly there.

---

## 5. Options

```sh
./start                    # build if needed, run, open a browser
./start --rebuild          # force a fresh image build first
./start --no-open          # don't touch the browser
./start --install-desktop  # add the applications-menu launcher
./start --help             # this list
```

Environment overrides:

| Variable | Effect |
|---|---|
| `ROOTFIT_DOCKER=podman` | use Podman instead of Docker |
| `ROOTFIT_PLATFORM=` | drop `--platform linux/amd64` and build for your native architecture |
| `ROOTFIT_PORT=9000` | serve on a different port |

They combine, e.g. `ROOTFIT_PORT=9000 ROOTFIT_DOCKER=podman ./start`.

---

## 6. Everyday use

**Editing a page** (anything in `frontend/`) — just save and reload the browser.
The folder is bind-mounted into the container, so there is nothing to rebuild.

**Editing the backend** (anything in `backend/`) — stop with Ctrl-C and run
`./start` again. It notices the change and rebuilds automatically.

**Is it running?**

```sh
docker ps -f name=rootfit
curl -s http://localhost:8000/health
```

**Stop it from another terminal**

```sh
docker rm -f rootfit
```

---

## 7. Troubleshooting

### "not allowed to talk to it" / permission denied

You're not in the `docker` group, or you haven't logged out since being added.
See step 2. `newgrp docker` fixes the current terminal without a full re-login.

### "the daemon is not running"

```sh
sudo systemctl start docker
sudo systemctl enable docker      # start it at boot too
systemctl status docker           # if it refuses to start, this says why
```

### "port 8000 is already allocated"

Something else has the port. Find it, or move:

```sh
ss -lptn 'sport = :8000'
ROOTFIT_PORT=9000 ./start
```

### The page is blank or everything 404s, but `/health` works

Almost always SELinux (Fedora, RHEL, and relatives) blocking the container's
read of the bind-mounted `frontend/` folder. `./start` handles this by adding
the `,z` mount flag when `getenforce` reports `Enforcing`, so if you still hit
it, check:

```sh
getenforce
sudo ausearch -m avc -ts recent | tail
```

A manual run needs the flag spelled out:

```sh
docker run --rm -p 8000:8000 -v "$PWD/frontend:/app/frontend:ro,z" rootfit-backend
```

### "exec format error", or the build dies on an ARM machine

The image is built for `linux/amd64` by default, which needs emulation on ARM.
Either install it:

```sh
sudo apt install -y qemu-user-static binfmt-support    # Debian/Ubuntu
```

or build natively instead:

```sh
ROOTFIT_PLATFORM= ./start --rebuild
```

Native is much faster when it works. Whether it does depends on the
`rootproject/root` image publishing an arm64 tag.

### The browser doesn't open

The server is still fine — open <http://localhost:8000> yourself. `./start`
uses `xdg-open`, then `gio open`. To get automatic opening:

```sh
sudo apt install -y xdg-utils       # Debian/Ubuntu
sudo dnf install -y xdg-utils       # Fedora
```

Note that `/usr/bin/open` on Linux is often `openvt`, not a browser opener —
`./start` deliberately ignores it.

### The build fails while downloading

Usually DNS or a corporate proxy. Test with `docker run --rm alpine ping -c1
deb.debian.org`. For a proxy, configure it for the Docker daemon (a
`~/.docker/config.json` proxy entry, or a systemd drop-in), not just your shell.

### "no space left on device"

The ROOT image is large. Reclaim:

```sh
docker system df
docker system prune -a      # removes all unused images — read the prompt
```

### Rootless Docker

Works, with two caveats: ports below 1024 are unavailable (8000 is fine), and
the bind mount maps your UID, so the frontend folder must be readable by you —
which it is by default.

### WSL2

Treat it as Linux: install Docker inside the WSL distribution, or enable Docker
Desktop's WSL integration. `./start` behaves as documented. The browser opens on
the Windows side via `wslview` if `xdg-open` is wired to it; otherwise open the
URL manually.

---

## 8. Running the pieces by hand

If you'd rather not use the script:

```sh
docker build --platform linux/amd64 -t rootfit-backend backend
docker run --rm -p 8000:8000 -v "$PWD/frontend:/app/frontend:ro" rootfit-backend
```

Add `,z` to the mount under SELinux. Omitting `-v` gives you the API alone; the
pages then still work opened straight from disk and will fall back to
`http://localhost:8000` for the API.

Check the API on its own:

```sh
curl -s http://localhost:8000/health
```

---

## 9. Removing it

```sh
docker rm -f rootfit                                  # the container
docker image rm rootfit-backend                       # the image
docker image rm rootproject/root                      # the large base image
rm -f .rootfit-image-stamp                            # the build marker
rm -f ~/.local/share/applications/rootatron3000.desktop   # the launcher
```

Nothing is installed outside Docker and that one desktop file. The tool stores
no data on any server — your analyses live in the `.json` documents you save and
in your browser's local storage.
