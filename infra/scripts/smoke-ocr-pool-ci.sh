#!/usr/bin/env bash
set -euo pipefail

image="${1:?Expected the built API image}"
tag="maxim-ocr-pool-ci-$$"
entrypoint=apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js
smoke=apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js
names=("$tag-1" "$tag-2" "$tag-3")
volumes=("$tag-ipc-1" "$tag-ipc-2" "$tag-ipc-3")
directories=(/run/maxim-ocr /run/maxim-ocr-2 /run/maxim-ocr-3)
pool_paths="${directories[1]}/native-ocr.sock,${directories[2]}/native-ocr.sock"

cleanup() {
  docker rm -f "${names[@]}" >/dev/null 2>&1 || true
  docker volume rm "${volumes[@]}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

common=(
  --init --read-only --user 1000:1000 --network none
  --cap-drop ALL --security-opt no-new-privileges
  --env NODE_ENV=production
  --env PHOTO_DUPLICATE_MAX_BYTES=16777216
  --env COMMERCIAL_OCR_MAX_INPUT_PIXELS=40000000
  --env COMMERCIAL_OCR_MAX_OUTPUT_PIXELS=3000000
  --env COMMERCIAL_OCR_MAX_SIDE=2000
  --env COMMERCIAL_OCR_TESSERACT_BINARY=tesseract
  --env COMMERCIAL_OCR_TESSERACT_CONCURRENCY=1
  --env COMMERCIAL_OCR_TESSERACT_MAX_QUEUE=4
  --env COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS=250
  --env COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS=10000
  --env COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES=16777216
  --env COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES=4194304
  --env OMP_THREAD_LIMIT=1
)
consumer=()
for i in "${!names[@]}"; do
  docker volume create "${volumes[i]}" >/dev/null
  socket_path="${directories[i]}/native-ocr.sock"
  docker run -d --name "${names[i]}" "${common[@]}" --cpus 1 --memory 1g --pids-limit 128 \
    --tmpfs '/tmp:rw,nosuid,size=64m,uid=1000,gid=1000' \
    --mount "type=volume,source=${volumes[i]},target=${directories[i]}" \
    --env COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH="$socket_path" \
    --entrypoint node "$image" "$entrypoint" >/dev/null
  consumer+=(--mount "type=volume,source=${volumes[i]},target=${directories[i]},readonly")
done

smoke_pool() {
  docker run --rm "${common[@]}" "${consumer[@]}" \
    --env APP_SERVICE_NAME=api-media-analysis --env APP_ROLE=moderation \
    --env COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH="${directories[0]}/native-ocr.sock" \
    --env COMMERCIAL_OCR_NATIVE_SANDBOX_POOL_SOCKET_PATHS="$pool_paths" \
    --entrypoint node "$image" "$smoke" "$1"
}

smoke_pool 3
# Lose the original endpoint to detect accidental affinity to the primary socket.
docker stop -t 3 "${names[0]}" >/dev/null
smoke_pool 2
docker start "${names[0]}" >/dev/null
smoke_pool 3
