# The tools a take needs on the demo host, which has no node — docs/296 plan
# §9: node, git and curl, the pinned Playwright with the Chromium build it
# expects (the official image for that version), and a full ffmpeg for the
# cut. The version is the repo's pinned `playwright` devDependency;
# demo-take.test.ts fails when the two differ.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
# ShipIt's UI is set in the system font, so the image's fonts are on camera:
# without DejaVu the default sans here is a CJK face with no bold.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -f \
  && fc-match system-ui | grep -q "DejaVu Sans"
WORKDIR /demo
# The pipeline is mounted at /demo/pipeline; its `import "playwright"` resolves here.
RUN npm install --no-save --no-package-lock --no-audit --no-fund playwright@1.62.1
