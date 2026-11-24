# Broker system recovery — 2026-11-11

The running systemd broker uses `/etc/mosquitto/mosquitto.conf`. Its readable active configuration contains listeners on 1883 and 8883, TLS certificate paths, and `allow_anonymous true`. It loads no Dynamic Security plugin or configuration. This explains why MQTT clients connect while management requests time out. Setting `MQTT_DYNSEC_ENABLED=true` in the backend does not enable a broker plugin.

`mosquitto-dynsec.conf.example` is a staged replacement, not an installed configuration. It preserves the current listener addresses and TLS files, enables the installed plugin, and requires authentication. The Dynamic Security state belongs at `/var/lib/mosquitto/dynamic-security.json`; the broker user needs read/write access and permission to replace it in its parent directory.

Deployment prerequisites:

1. Back up the current broker config and any existing Dynamic Security state with restrictive permissions.
2. Provision an admin principal and `agri_backend` with the existing backend environment credentials. The backend role must cover the topic contract in `scripts/setup-local-mqtt.js`. Admin initialization alone is insufficient.
3. Install the staged configuration and state, restart the system broker, and check the service journal. Roll back the config if startup fails.
4. Verify the management channel with read-only `getClient` and `getRole` requests for the target node before using reconciliation. This direct authenticated probe requires explicit user approval in this session.
5. Reconcile the consumed claim, restore the node if revoked, issue a new token, claim via USB, and upload the generated firmware configuration. Sensors must then be PROVISIONED before their telemetry can be stored.

Do not run `mqtt:setup` blindly against the occupied system port: that script manages a separate project broker, can rewrite `.env`, and does not itself replace the systemd broker configuration. Do not clear claim database markers to work around an unresponsive management channel.

No system broker configuration or credentials were changed while preparing these files. The direct authenticated probe was blocked by approval review, so no account-existence result has been obtained.
