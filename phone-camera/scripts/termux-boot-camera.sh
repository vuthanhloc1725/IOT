#!/data/data/com.termux/files/usr/bin/bash
# Copy to ~/.termux/boot/phone-camera (requires the Termux:Boot app).
CAMERA_DIR="$HOME/phone-camera"
mkdir -p "$CAMERA_DIR/logs"
termux-wake-lock
sleep 20   # let Wi-Fi / mobile data come up
nohup "$CAMERA_DIR/scripts/run_camera.sh" >> "$CAMERA_DIR/logs/camera-agent.log" 2>&1 &
