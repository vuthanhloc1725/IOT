# Smartphone camera node design

## Scope

This design uses an Android smartphone with Termux, Termux:API and Python as a
second camera node. It is intentionally independent of the current `Backend/`
and `Frontend/` implementation. The backend must implement the MQTT consumer,
media assembler, storage ACK and dashboard presentation described below before
the complete end-to-end flow works.

The existing ESP32 soil/DHT11/pump node remains unchanged. The phone is not an
ESP32 device and must receive its own identity and MQTT credentials.

## Hardware and deployment

| Item | Recommendation |
| --- | --- |
| Phone | Android phone with a working rear camera, 2 GB+ free storage |
| Mount | Fixed bracket aimed at the plant/greenhouse zone; avoid vibration |
| Power | Continuous USB power with a good cable and charger |
| Network | Stable Wi-Fi; use a restricted VLAN if possible |
| Software | Termux, Termux:API, Python, Paho MQTT, `ffmpeg` |
| Privacy | No people-facing area; document retention and access policy |

The phone should be assigned `PHONE-CAM-<unique>` as its camera identity. Its
MQTT account must be separate from the backend account and every other node.
Broker ACL should allow the phone to publish and subscribe only under its own
topic root.

## Agent files

- `phone-camera/camera_agent.py`: MQTT loop, capture, SQLite spool and upload.
- `phone-camera/config.example.json`: non-secret configuration template.
- `phone-camera/scripts/install_termux.sh`: Termux package setup.
- `phone-camera/scripts/run_camera.sh`: long-running launcher with wake lock.
- `phone-camera/scripts/termux-boot-camera.sh`: optional boot launcher.
- `phone-camera/tests/test_agent.py`: queue/config tests that do not require a phone.

## MQTT topic contract

The default root is `camera/{cameraId}`. The configured `topic_prefix` may be
changed, but the backend and ACL must use the same value.

| Direction | Topic | QoS | Retain | Purpose |
| --- | --- | --- | --- | --- |
| Phone -> backend | `camera/{cameraId}/heartbeat` | 1 | no | Liveness and queue depth |
| Phone -> backend | `camera/{cameraId}/status` | 1 | no | `online`/`offline` state |
| Backend -> phone | `camera/{cameraId}/command` | 1 | no | Capture or video request |
| Phone -> backend | `camera/{cameraId}/command/ack` | 1 | no | Request accepted/failed |
| Phone -> backend | `camera/{cameraId}/media/meta` | 1 | no | Media manifest |
| Phone -> backend | `camera/{cameraId}/media/chunk` | 1 | no | Base64 chunk payload |
| Phone -> backend | `camera/{cameraId}/media/complete` | 1 | no | End marker and checksum |
| Backend -> phone | `camera/{cameraId}/media/ack` | 1 | no | Stored, duplicate or rejected |

Do not retain media events. Retained state may be used for a separate shadow,
but images and video are historical events.

## Command payloads

Image request:

```json
{
  "schemaVersion": 1,
  "action": "capture",
  "requestId": "req-20261103-0001",
  "camera": "back",
  "requestedAt": "2026-11-03T03:30:00.000Z"
}
```

Video/timelapse request:

```json
{
  "schemaVersion": 1,
  "action": "record_video",
  "requestId": "req-20261103-0002",
  "camera": "back",
  "durationSeconds": 10,
  "frameIntervalSeconds": 1,
  "requestedAt": "2026-11-03T03:31:00.000Z"
}
```

`requestId` is the idempotency key. The phone stores the command result and
replays the same ACK if the dashboard retries the command.

Command ACK:

```json
{
  "requestId": "req-20261103-0001",
  "cameraId": "PHONE-CAM-01",
  "success": true,
  "message": "media_queued",
  "eventId": "PHONE-CAM-01-1793695800-a1b2c3d4e5f6",
  "completedAt": "2026-11-03T03:30:08.000Z"
}
```

The command ACK means the media was captured and queued locally. It does not
mean the backend has stored the media. The backend must use `media/ack` for the
storage result.

## Media upload protocol

1. Phone captures a file and computes `sha256` over raw bytes.
2. Phone publishes one `media/meta` manifest.
3. Phone publishes `media/chunk` messages with zero-based indexes.
4. Phone publishes one `media/complete` message.
5. Backend validates, assembles and atomically stores the file.
6. Backend publishes `media/ack` with `stored`, `duplicate` or `rejected`.
7. Phone deletes its local file only after `stored` or `duplicate`.

Metadata:

```json
{
  "schemaVersion": 1,
  "cameraId": "PHONE-CAM-01",
  "eventId": "PHONE-CAM-01-1793695800-a1b2c3d4e5f6",
  "requestId": "req-20261103-0001",
  "mediaType": "image",
  "mimeType": "image/jpeg",
  "capturedAt": "2026-11-03T03:30:08.000Z",
  "sizeBytes": 184320,
  "chunkBytes": 16384,
  "totalChunks": 12,
  "sha256": "<64 lowercase hex characters>"
}
```

Chunk:

```json
{
  "eventId": "PHONE-CAM-01-1793695800-a1b2c3d4e5f6",
  "index": 0,
  "dataBase64": "<base64 of raw bytes for this chunk>"
}
```

Complete:

```json
{
  "eventId": "PHONE-CAM-01-1793695800-a1b2c3d4e5f6",
  "totalChunks": 12,
  "sizeBytes": 184320,
  "sha256": "<same hash as metadata>"
}
```

ACK:

```json
{
  "eventId": "PHONE-CAM-01-1793695800-a1b2c3d4e5f6",
  "status": "stored",
  "storedId": "media-uuid-from-server",
  "receivedAt": "2026-11-03T03:30:10.000Z"
}
```

For `rejected`, include a short machine-readable `reason` such as
`sha256_mismatch`, `chunk_missing`, `too_large`, `unsupported_mime` or
`unauthorized_camera`. The phone keeps the file and retries unless the error is
permanent; for permanent authorization errors, an operator must inspect the
log instead of retrying forever.

## Backend processing checklist

The backend should add a dedicated media-ingestion service without changing
the existing AI result flow:

1. Subscribe to `camera/+/heartbeat`, `camera/+/status`,
   `camera/+/command/ack`, `camera/+/media/meta`, `camera/+/media/chunk`, and
   `camera/+/media/complete`.
2. Extract `cameraId` from the topic and verify it is registered, active and
   owned/assigned to the requesting tenant/user.
3. Keep an in-memory or temporary-file assembly session keyed by `eventId`.
   Reject a different manifest if the same `eventId` already exists.
4. Enforce limits before allocating storage: maximum image/video bytes,
   maximum chunks, maximum chunk size, allowed MIME types, allowed event ID
   characters and a session timeout.
5. Decode each Base64 chunk, validate the index and reject duplicate indexes
   with different bytes.
6. On `complete`, verify chunk count, byte count, SHA-256 and media signature
   (JPEG `FF D8 FF`; MP4 `ftyp` box). Never trust MIME alone.
7. Move the assembled temporary file atomically into private media storage and
   persist metadata: `cameraId`, `eventId`, `requestId`, media type, MIME,
   captured time, received time, size, hash, storage path and processing state.
8. Publish `stored` or `duplicate` ACK only after the database/storage commit.
9. Emit a Socket.IO/dashboard event such as `camera:media:new` with a protected
   media ID, not a public filesystem path. The dashboard fetches the image/video
   through an authenticated API.
10. Optionally enqueue images for the existing AI pipeline. Do not publish raw
    images to `iot/ai/result`; that topic expects a completed AI result payload.

Recommended processing states:

```text
RECEIVING -> STORED -> PROCESSING -> PROCESSED
                    \-> FAILED
```

## Security and privacy

- Use a unique MQTT username/password per phone and an ACL limited to its own
  root. Do not reuse the backend MQTT account.
- Use `mqtts://` with certificate verification; never use insecure TLS.
- Do not put credentials or CA private keys in Git.
- Authorize dashboard commands on the backend before publishing them.
- Validate the camera assignment again when ingesting media.
- Keep media private and serve it through JWT/role-checked endpoints.
- Decide a retention period and deletion job for photos and videos.
- Avoid capturing people, faces, or private spaces; document consent where needed.
- Limit video duration and upload rate to control battery, storage and network cost.

## Acceptance tests

1. Set interval to 60 seconds; verify each event has a unique `eventId` and the
   backend receives metadata/chunks/complete in order.
2. Send one `capture` request; verify command ACK, stored media ACK and
   dashboard event.
3. Repeat the same `requestId`; verify the phone returns the same command ACK
   and does not capture twice.
4. Disconnect Wi-Fi after `complete` but before media ACK; reconnect and verify
   the same event is resent and backend returns `duplicate` without a second
   database row.
5. Drop a chunk; backend must reject `chunk_missing` and the phone must retain
   the file.
6. Request a 10-second timelapse; verify an MP4 is stored and playable.
7. Request a duration above the configured maximum; verify phone clamps it.
8. Revoke the MQTT account; verify no media is accepted and the local spool is
   retained for later retry.
9. Attempt to publish under another camera's topic; broker ACL must reject it.
10. Request a media URL as a user without camera assignment; backend must deny it.

## Known limitations

- Android background execution can stop Termux. This is suitable for a demo or
  fixed installation with power and battery optimization disabled, not a fully
  managed production camera.
- `record_video` is a timelapse implementation using still frames and ffmpeg,
  not continuous video capture.
- The existing backend does not implement these topics yet; this deliverable is
  the independent phone agent and the integration contract only.
