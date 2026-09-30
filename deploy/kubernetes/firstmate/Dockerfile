# syntax=docker/dockerfile:1
#
# firstmate runtime image for the Kubernetes chart in deploy/helm/firstmate.
#
# The image bakes the firstmate distro and its herdr/treehouse toolchain as a
# seed at /opt/firstmate. On first start the entrypoint copies the seed into
# the persistent firstmate home, runs the herdr headless server, and starts the
# primary harness inside the session, restarting it if it exits, so the session
# stays attachable from `kubectl exec -it ... -- herdr` and a live firstmate
# drains queued instructions instead of only the server.
#
# Build (context is this directory):
#   docker build -t firstmate-runtime:0.1.0 deploy/kubernetes/firstmate
#
# The harness (the coding agent firstmate runs as its primary) is installed
# from HARNESS_PACKAGES. The default is the opencode CLI; override it for
# another harness, or set it empty and install your own on top.
#
# The image also carries the command-line tools a firstmate home expects on
# PATH: no-mistakes plus the AXI-family tools (gh-axi, chrome-devtools-axi,
# tasks-axi, quota-axi, lavish-axi). They are pinned to the versions current at
# the pinned firstmate ref's floors (bin/fm-bootstrap.sh: NO_MISTAKES_MIN,
# GH_AXI_MIN, LAVISH_AXI_MIN, and the tasks-axi/quota-axi floors), so a deployed
# home boots with no MISSING-tool diagnostics and without drift. Bump
# FIRSTMATE_REF and these ARGs together; see docs/deploy-kubernetes.md.
#
# FIRSTMATE_REF pins the distro to one immutable commit so the runtime image is
# reproducible and no mutable branch can change it on a later build. It is the
# firstmate commit the deployed image was built from; bump it deliberately and
# reconcile patches/ against the new tree.
#
# patches/ carries the repo's deliberate deltas to that pinned distro.
#
# 0001-opencode-arm-without-task.patch: the OpenCode watch-arm plugin is patched
# so supervision arms on a lock-owned primary even when no state/*.meta task
# exists. Upstream arms only on a task or x-mode, which left a freshly booted
# home whose only pending work is a queued inbox note without a watcher, so the
# note sat undrained.
#
# 0002-handling-successor-resurface-downtime.patch: the watcher's
# resurface_after_downtime no longer skips handling successors. Upstream skipped
# the durable recovery resurface for a re-armed watcher, which removed the only
# wake path for a queued inbox note; in a deployed home whose only work is
# captain notes, every note after the first sat in the wake queue forever. The
# once-per-generation arm check already prevents the re-announce loop the skip
# was guarding against.
#
# The entrypoint refreshes both patched files into an existing home below, so a
# retained volume gets the deltas too.
#
# This is one generic way to package the runtime, not a requirement: point the
# chart's firstmate.image at any image that provides the same contract
# (firstmate distro, herdr, treehouse, a harness, and this entrypoint's
# seeding behavior or an equivalent).

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG FIRSTMATE_REPO=https://github.com/kunchenguid/firstmate
ARG FIRSTMATE_REF=eb77f02b16aeca9533102070de34b1f8812f4fa2
ARG HARNESS_PACKAGES=opencode-ai

# AXI-family and no-mistakes versions a firstmate expects, pinned to the
# versions that satisfy the pinned firstmate ref's floors. Bump alongside
# FIRSTMATE_REF.
ARG NO_MISTAKES_VERSION=1.84.0
ARG GH_AXI_VERSION=0.1.35
ARG CHROME_DEVTOOLS_AXI_VERSION=0.1.35
ARG TASKS_AXI_VERSION=0.2.6
ARG QUOTA_AXI_VERSION=0.1.55
ARG LAVISH_AXI_VERSION=0.1.80

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    gnupg \
    jq \
    less \
    openssh-client \
    procps \
    python3 \
    rsync \
    tini \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI from its official apt repository.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# firstmate distro seed. The running home is a PersistentVolume seeded from
# here on first start; AGENTS.md plus bin/ are the distro. FIRSTMATE_REF is the
# pinned commit above.
#
# Apply the repo's patches to the pinned checkout. `git apply` is strict: if a
# later FIRSTMATE_REF bump moves the patched context, the build fails here
# rather than shipping an unpatched watcher gate. The patch is committed in the
# seed so firstmate's home starts from a clean distro tree; only the runtime
# image carries this local commit, since the ref above pins the upstream base.
COPY patches/ /tmp/firstmate-patches/
RUN git clone "${FIRSTMATE_REPO}" /opt/firstmate \
  && git -C /opt/firstmate checkout --detach "${FIRSTMATE_REF}" \
  && for p in /tmp/firstmate-patches/*.patch; do git -C /opt/firstmate apply "$p"; done \
  && git -C /opt/firstmate \
       -c user.name=firstmate-runtime \
       -c user.email=firstmate-runtime@localhost \
       commit -am "runtime: carry the repo's deliberate firstmate deltas" \
  && rm -rf /tmp/firstmate-patches

# herdr and treehouse, via firstmate's own pinned installers so the image
# matches the versions firstmate verifies against.
RUN /opt/firstmate/bin/fm-install-herdr.sh /usr/local/bin \
  && /opt/firstmate/bin/fm-install-treehouse.sh /usr/local/bin

# OpenCode's herdr integration plugin. It reports the pane's agent session id
# (`ses_...`) to the herdr server, which surfaces it as `agent_session` in
# `herdr pane list`; the walkie-talkie Conversations view needs that id to open
# the session's real message history in the agent store instead of falling back
# to the terminal's visible screen. herdr's own `integration install` writes to
# the global `~/.config/opencode/plugins`, but in this deployment
# `~/.config/opencode` is a Kubernetes mount point for the agents ConfigMap and
# is not writable by the unprivileged runtime user, so bake the plugin into the
# seed's project-level plugin directory instead, beside firstmate's own OpenCode
# plugins. The entrypoint refreshes it into a retained home.
RUN mkdir -p /tmp/herdr-integration/.config/opencode \
  && HOME=/tmp/herdr-integration herdr integration install opencode \
  && install -Dm 0644 /tmp/herdr-integration/.config/opencode/plugins/herdr-agent-state.js \
       /opt/firstmate/.opencode/plugins/herdr-agent-state.js \
  && rm -rf /tmp/herdr-integration

# Primary harness.
RUN if [ -n "${HARNESS_PACKAGES}" ]; then npm install -g ${HARNESS_PACKAGES}; fi

# no-mistakes ships as a static release binary. Install it directly from the
# pinned release and verify its published checksum, rather than through its
# installer, which resolves "latest" (not reproducible) and restarts the shared
# daemon at install time (unwanted in an image build; firstmate owns the daemon
# at runtime).
RUN set -eux; \
  case "$(dpkg --print-architecture)" in \
    amd64) nm_arch=amd64 ;; \
    arm64) nm_arch=arm64 ;; \
    *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  tag="v${NO_MISTAKES_VERSION}"; \
  asset="no-mistakes-${tag}-linux-${nm_arch}.tar.gz"; \
  base="https://github.com/kunchenguid/no-mistakes/releases/download/${tag}"; \
  tmp="$(mktemp -d)"; \
  curl -fsSL "${base}/${asset}" -o "${tmp}/${asset}"; \
  curl -fsSL "${base}/checksums.txt" -o "${tmp}/checksums.txt"; \
  expected="$(awk -v a="${asset}" '$2 == a { print $1 }' "${tmp}/checksums.txt")"; \
  actual="$(sha256sum "${tmp}/${asset}" | awk '{ print $1 }')"; \
  [ -n "${expected}" ] && [ "${expected}" = "${actual}" ] \
    || { echo "checksum mismatch for ${asset}" >&2; exit 1; }; \
  tar -xzf "${tmp}/${asset}" -C "${tmp}"; \
  install -m 0755 "${tmp}/no-mistakes" /usr/local/bin/no-mistakes; \
  rm -rf "${tmp}"

# AXI-family tools a firstmate expects, from npm. Installed globally under
# /usr/local so the unprivileged firstmate user finds them on PATH.
RUN npm install -g \
    "gh-axi@${GH_AXI_VERSION}" \
    "chrome-devtools-axi@${CHROME_DEVTOOLS_AXI_VERSION}" \
    "tasks-axi@${TASKS_AXI_VERSION}" \
    "quota-axi@${QUOTA_AXI_VERSION}" \
    "lavish-axi@${LAVISH_AXI_VERSION}"

# Reuse the node image's uid/gid 1000 user, renamed to firstmate with the home
# path the chart mounts.
RUN usermod -l firstmate -d /home/firstmate -m -s /bin/bash node \
  && groupmod -n firstmate node

COPY entrypoint.sh /usr/local/bin/firstmate-entrypoint
RUN chmod 0755 /usr/local/bin/firstmate-entrypoint

ENV HOME=/home/firstmate \
    FM_HOME=/home/firstmate \
    HERDR_SESSION=firstmate \
    NODE_ENV=production

USER firstmate

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/firstmate-entrypoint"]
