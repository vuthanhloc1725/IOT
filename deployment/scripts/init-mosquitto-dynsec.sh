#!/bin/sh
set -eu

: "${MQTT_DYNSEC_ADMIN_USERNAME:?Set MQTT_DYNSEC_ADMIN_USERNAME in deployment/.env}"
: "${MQTT_DYNSEC_ADMIN_PASSWORD:?Set MQTT_DYNSEC_ADMIN_PASSWORD in deployment/.env}"

DATA_DIR=/mosquitto/data
DYNSEC_FILE="$DATA_DIR/dynamic-security.json"
mkdir -p "$DATA_DIR"

# mosquitto_ctrl creates the initial administrator account and DynSec JSON file.
# Preserve the existing file on every subsequent start; never reset live broker ACLs.
if [ ! -s "$DYNSEC_FILE" ]; then
  mosquitto_ctrl dynsec init "$DYNSEC_FILE" \
    "$MQTT_DYNSEC_ADMIN_USERNAME" "$MQTT_DYNSEC_ADMIN_PASSWORD"
fi

# The broker drops privileges to UID/GID 1883 in the official container image.
chown -R 1883:1883 "$DATA_DIR"
chmod 750 "$DATA_DIR"
chmod 600 "$DYNSEC_FILE"
