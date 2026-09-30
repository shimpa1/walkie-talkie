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
# FIRSTMATE_REF pins the distro to one immutable commit so the runtime image is
# reproducible and no mutable branch can change it on a later build. It is the
# firstmate commit the deployed image was built from; bump it deliberately and
# reconcile patches/ against the new tree.
#
# patches/ carries the repo's deliberate deltas to that pinned distro. The
# OpenCode watch-arm plugin is patched so supervision arms on a lock-owned
# primary even when no state/*.meta task exists. Upstream arms only on a task
# or x-mode, which left a freshly booted home whose only pending work is a
# queued inbox note without a watcher, so the note sat undrained. The entrypoint
# also refreshes the patched plugin into an existing home below.
#
# This is one generic way to package the runtime, not a requirement: point the
# chart's firstmate.image at any image that provides the same contract
# (firstmate distro, herdr, treehouse, a harness, and this entrypoint's
# seeding behavior or an equivalent).

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG FIRSTMATE_REPO=https://github.com/kunchenguid/firstmate
ARG FIRSTMATE_REF=c5f48e4cad279e6acaf14208522c44e28fac6835
ARG HARNESS_PACKAGES=opencode-ai

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
  && git -C /opt/firstmate apply /tmp/firstmate-patches/0001-opencode-arm-without-task.patch \
  && git -C /opt/firstmate \
       -c user.name=firstmate-runtime \
       -c user.email=firstmate-runtime@localhost \
       commit -am "runtime: arm OpenCode supervision without a task in flight" \
  && rm -rf /tmp/firstmate-patches

# herdr and treehouse, via firstmate's own pinned installers so the image
# matches the versions firstmate verifies against.
RUN /opt/firstmate/bin/fm-install-herdr.sh /usr/local/bin \
  && /opt/firstmate/bin/fm-install-treehouse.sh /usr/local/bin

# Primary harness.
RUN if [ -n "${HARNESS_PACKAGES}" ]; then npm install -g ${HARNESS_PACKAGES}; fi

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
