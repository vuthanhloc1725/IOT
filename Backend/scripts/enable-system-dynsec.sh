#!/usr/bin/env bash
# Bật Mosquitto Dynamic Security cho broker hệ thống (systemd, /etc/mosquitto/mosquitto.conf).
# Tài khoản admin + tài khoản Backend lấy từ Backend/.env (MQTT_DYNSEC_ADMIN_*, MQTT_USERNAME/PASSWORD).
# Chạy:  sudo bash scripts/enable-system-dynsec.sh      (chạy lại nhiều lần vẫn an toàn)
set -euo pipefail

[[ $EUID -eq 0 && -n "${SUDO_USER:-}" ]] || { echo "Chạy bằng: sudo bash $0"; exit 1; }

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONF=/etc/mosquitto/mosquitto.conf
PLUGIN=/usr/lib/mosquitto_dynamic_security.so
DATA_DIR=/var/lib/mosquitto
DYNSEC_JSON=$DATA_DIR/dynamic-security.json

envval() {
  sudo -u "$SUDO_USER" node -e '
    require(process.argv[1] + "/node_modules/dotenv").config({ path: process.argv[1] + "/.env", quiet: true });
    process.stdout.write(process.env[process.argv[2]] || "");' "$BACKEND_DIR" "$1"
}

[[ -f $PLUGIN ]] || { echo "Không thấy $PLUGIN"; exit 1; }
ADMIN_USER="$(envval MQTT_DYNSEC_ADMIN_USERNAME)"
ADMIN_PASS="$(envval MQTT_DYNSEC_ADMIN_PASSWORD)"
[[ -n $ADMIN_USER && -n $ADMIN_PASS && $ADMIN_PASS != replace-with* ]] \
  || { echo "Backend/.env thiếu MQTT_DYNSEC_ADMIN_USERNAME/PASSWORD (hoặc vẫn là giá trị mẫu)"; exit 1; }
[[ "$(envval MQTT_DYNSEC_ENABLED)" == "true" ]] || echo "!! Nhớ đặt MQTT_DYNSEC_ENABLED=true trong Backend/.env"

# 1) File dữ liệu Dynamic Security (giữ nguyên nếu đã có)
install -d -o mosquitto -g mosquitto -m 700 "$DATA_DIR"
if [[ ! -f $DYNSEC_JSON ]]; then
  mosquitto_ctrl dynsec init "$DYNSEC_JSON" "$ADMIN_USER" "$ADMIN_PASS" >/dev/null
  echo "[1] Đã tạo $DYNSEC_JSON với admin \"$ADMIN_USER\""
else
  echo "[1] Giữ $DYNSEC_JSON đã có (mật khẩu admin trong đó phải trùng Backend/.env)"
fi
chown mosquitto:mosquitto "$DYNSEC_JSON"
chmod 600 "$DYNSEC_JSON"

# 2) Nạp plugin + tắt đăng nhập ẩn danh (sao lưu trước khi sửa)
BACKUP=""
if ! grep -qE "^[[:space:]]*plugin[[:space:]]+$PLUGIN" "$CONF"; then
  BACKUP="$CONF.bak-dynsec-$(date +%Y%m%d%H%M%S)"
  cp -p "$CONF" "$BACKUP"
  awk -v plugin="$PLUGIN" -v json="$DYNSEC_JSON" '
    !done && /^[[:space:]]*listener[[:space:]]/ {
      print "# --- IoT_Control_Fullstack: Dynamic Security (scripts/enable-system-dynsec.sh) ---"
      print "plugin " plugin
      print "plugin_opt_config_file " json
      print ""
      done = 1
    }
    { print }' "$BACKUP" > "$CONF"
  echo "[2] Đã thêm plugin vào $CONF (bản sao lưu: $BACKUP)"
else
  echo "[2] $CONF đã nạp plugin"
fi
sed -i -E 's/^([[:space:]]*)allow_anonymous[[:space:]]+true[[:space:]]*$/\1allow_anonymous false/' "$CONF"

# 3) Khởi động lại; lỗi thì trả cấu hình cũ
systemctl restart mosquitto
sleep 2
if ! systemctl is-active --quiet mosquitto; then
  journalctl -u mosquitto -n 20 --no-pager
  if [[ -n $BACKUP ]]; then cp -p "$BACKUP" "$CONF"; systemctl restart mosquitto; echo "Đã trả lại cấu hình cũ"; fi
  exit 1
fi
echo "[3] Mosquitto đã chạy lại với Dynamic Security"

# 4) Tài khoản + quyền cho Backend
cd "$BACKEND_DIR"
sudo -u "$SUDO_USER" node scripts/ensure-backend-mqtt-account.js
echo "Xong. Khởi động lại Backend (npm run dev) rồi bấm \"Kiểm tra broker & mở lại claim\" trên web."
