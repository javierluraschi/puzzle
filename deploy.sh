#!/bin/bash
# Builds the image on Cloudish from this directory and redeploys https://jigsawsolver.on.do.cloudish.ai/
set -euo pipefail
cd "$(dirname "$0")"
source .env
tar --exclude='.env*' --exclude='.git' --exclude='./tools' --exclude='./data' --exclude='./vendor' \
    --exclude='context.tar.gz' --exclude='prompt.md' --exclude='./public/_t' --exclude='./public/_tb' --exclude='./public/vendor' --exclude='./public/models' --exclude='./tests' --exclude='./node_modules' -czf context.tar.gz .
build=$(curl -sf -X POST https://cloudish.ai/api/v1/projects -H "Authorization: Bearer $CLOUDISH_API_KEY" \
  -F name=jigsaw -F port=8080 -F context=@context.tar.gz \
  -F volumeEnabled=true -F volumeSizeGb=1 -F volumeMountPath=/data "$@" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['build']['id'])")
echo "build $build"
while true; do
  r=$(curl -sf "https://cloudish.ai/api/v1/images/builds/$build" -H "Authorization: Bearer $CLOUDISH_API_KEY" || true)
  s=$(echo "$r" | python3 -c "import json,sys; print(json.load(sys.stdin)['build']['status'])" 2>/dev/null || echo unknown)
  case "$s" in
    succeeded) echo "build succeeded"; break ;;
    failed) echo "$r" | python3 -c "import json,sys; b=json.load(sys.stdin)['build']; print(b.get('error')); print((b.get('logs') or '')[-4000:])"; exit 1 ;;
  esac
  sleep 8
done
rm -f context.tar.gz
