#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "cJSON.h"
#include "driver/gpio.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_sntp.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "mqtt_client.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "logic.h"
#include "sensors.h"

#define FW_VERSION "1.0.0"
#define PUMP_PIN GPIO_NUM_26
#define PUMP_ON_LEVEL 0 /* Change to 1 if the measured relay module is active HIGH. */
#define SAMPLE_MS 10000
#define TELEMETRY_MS 20000
#define HEARTBEAT_MS 20000
#define BACKLOG_CAP 32
#define COMMAND_MAX 2048

static const char *TAG = "smart_farm";

typedef struct {
    char wifi_ssid[33], wifi_pass[65];
    char broker[160], mqtt_user[80], mqtt_pass[128];
    char prefix[32], node[52], soil_code[48], dht_code[48], pump_code[48];
    char ca_pem[4096];
    int dry_raw, wet_raw;
} provision_t;

static provision_t provision;
static pump_policy_t policy = { .auto_enabled = false, .on_pct = 35,
    .off_pct = 60, .max_run_sec = 30, .cooldown_sec = 60 };
static esp_mqtt_client_handle_t mqtt;
static char topic_cmd[120], topic_status[120], topic_telemetry[120], topic_backfill[120];
static char topic_heartbeat[120], topic_ack[120], topic_config_ack[120];
static volatile bool connected, pump_active, soil_active, dht_active, pump_running;
static volatile bool soil_valid, dht_valid, soil_fault_reported, dht_fault_reported;
static int soil_pct, soil_raw;
static float temp_c, humidity_pct;
static int64_t pump_started_ms, pump_stopped_ms, last_sample_ms;
static int64_t pump_deadline_ms;
static uint32_t boot_counter, sequence, dropped;
static int config_version;
static char last_uuid[64], last_device[48], last_reason[80];
static bool last_success;
static bool last_was_on;
#define SEEN_CAP 16
typedef struct { char uuid[64], device[48], reason[80]; bool success, was_on; } seen_command_t;
static seen_command_t seen[SEEN_CAP];
static size_t seen_next;
static char *backlog[BACKLOG_CAP];
static size_t backlog_head, backlog_len;
static char command_data[COMMAND_MAX + 1];
static char command_topic[120];
static int command_total;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

static bool get_str(nvs_handle_t nvs, const char *key, char *dst, size_t cap)
{
    size_t len = cap;
    return nvs_get_str(nvs, key, dst, &len) == ESP_OK && dst[0];
}

static bool load_provision(void)
{
    nvs_handle_t nvs;
    if (nvs_open("nodecfg", NVS_READONLY, &nvs) != ESP_OK) return false;
#define READ(k, field) get_str(nvs, k, provision.field, sizeof(provision.field))
    bool ok = READ("ssid", wifi_ssid) && READ("wifi_pass", wifi_pass) &&
        READ("broker", broker) && READ("user", mqtt_user) &&
        READ("pass", mqtt_pass) && READ("prefix", prefix) && READ("node", node) &&
        READ("soil", soil_code) && READ("dht", dht_code) && READ("pump", pump_code);
#undef READ
    (void)get_str(nvs, "ca_pem", provision.ca_pem, sizeof(provision.ca_pem));
    int32_t dry, wet;
    ok = ok && nvs_get_i32(nvs, "dry", &dry) == ESP_OK &&
        nvs_get_i32(nvs, "wet", &wet) == ESP_OK;
    nvs_close(nvs);
    if (!ok || strncmp(provision.broker, "mqtts://", 8) != 0 ||
        strlen(provision.prefix) + strlen(provision.node) > 85 ||
        dry < 0 || dry > 4095 || wet < 0 || wet > 4095 || dry == wet) return false;
    provision.dry_raw = dry;
    provision.wet_raw = wet;
    return true;
}

static void load_state(void)
{
    nvs_handle_t nvs;
    if (nvs_open("runtime", NVS_READWRITE, &nvs) != ESP_OK) return;
    uint32_t count = 0;
    (void)nvs_get_u32(nvs, "boot", &count);
    boot_counter = count + 1;
    (void)nvs_set_u32(nvs, "boot", boot_counter);
    int32_t v;
    if (nvs_get_i32(nvs, "version", &v) == ESP_OK) config_version = v;
    if (nvs_get_i32(nvs, "on_pct", &v) == ESP_OK) policy.on_pct = v;
    if (nvs_get_i32(nvs, "off_pct", &v) == ESP_OK) policy.off_pct = v;
    if (nvs_get_i32(nvs, "max_sec", &v) == ESP_OK) policy.max_run_sec = v;
    if (nvs_get_i32(nvs, "cool_sec", &v) == ESP_OK) policy.cooldown_sec = v;
    if (nvs_get_i32(nvs, "auto", &v) == ESP_OK) policy.auto_enabled = v != 0;
    (void)get_str(nvs, "last_uuid", last_uuid, sizeof(last_uuid));
    (void)get_str(nvs, "last_dev", last_device, sizeof(last_device));
    (void)get_str(nvs, "last_reason", last_reason, sizeof(last_reason));
    if (nvs_get_i32(nvs, "last_ok", &v) == ESP_OK) last_success = v != 0;
    if (nvs_get_i32(nvs, "last_on", &v) == ESP_OK) last_was_on = v != 0;
    (void)nvs_commit(nvs);
    nvs_close(nvs);
    if (!valid_pump_policy(&policy)) {
        policy = (pump_policy_t){ .auto_enabled = false, .on_pct = 35, .off_pct = 60,
            .max_run_sec = 30, .cooldown_sec = 60 };
    }
    // Activation is deliberately not restored after a cold boot.
    pump_active = soil_active = dht_active = false;
}

static int publish(const char *topic, const char *payload)
{
    if (!connected || !mqtt) return -1;
    return esp_mqtt_client_enqueue(mqtt, topic, payload, 0, 1, 0, true);
}

static void publish_json(const char *topic, cJSON *json)
{
    char *text = cJSON_PrintUnformatted(json);
    if (text) { (void)publish(topic, text); free(text); }
    cJSON_Delete(json);
}

static void status_event(const char *event, const char *sensor, const char *message)
{
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "event", event);
    if (sensor) cJSON_AddStringToObject(json, "sensor", sensor);
    cJSON_AddStringToObject(json, "message", message);
    publish_json(topic_status, json);
}

static void pump_off(void)
{
    gpio_set_level(PUMP_PIN, !PUMP_ON_LEVEL);
    if (pump_running) {
        pump_running = false;
        pump_stopped_ms = now_ms();
    }
}

static bool pump_on(int seconds)
{
    int64_t elapsed = now_ms() - pump_stopped_ms;
    if (!pump_active || !connected || !soil_valid || !soil_active ||
        seconds < 1 || seconds > policy.max_run_sec || pump_running ||
        (pump_stopped_ms && elapsed < (int64_t)policy.cooldown_sec * 1000)) return false;
    pump_started_ms = now_ms();
    pump_deadline_ms = pump_started_ms + (int64_t)seconds * 1000;
    gpio_set_level(PUMP_PIN, PUMP_ON_LEVEL);
    pump_running = true;
    return true;
}

static void ack(const char *uuid, const char *device, bool success, const char *reason)
{
    if (!uuid || !uuid[0]) return;
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "commandUuid", uuid);
    cJSON_AddStringToObject(json, "deviceCode", device);
    cJSON_AddBoolToObject(json, "success", success);
    cJSON_AddStringToObject(json, "message", reason);
    publish_json(topic_ack, json);
}

static void remember_ack(const char *uuid, const char *device, bool success, const char *reason)
{
    seen_command_t *entry = &seen[seen_next++ % SEEN_CAP];
    snprintf(entry->uuid, sizeof(entry->uuid), "%s", uuid);
    snprintf(entry->device, sizeof(entry->device), "%s", device);
    snprintf(entry->reason, sizeof(entry->reason), "%s", reason);
    entry->success = success;
    entry->was_on = success && !strcmp(reason, "on");
    snprintf(last_uuid, sizeof(last_uuid), "%s", uuid);
    snprintf(last_device, sizeof(last_device), "%s", device);
    snprintf(last_reason, sizeof(last_reason), "%s", reason);
    last_success = success;
    last_was_on = entry->was_on;
    nvs_handle_t nvs;
    if (nvs_open("runtime", NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_set_str(nvs, "last_uuid", last_uuid);
        nvs_set_str(nvs, "last_dev", last_device);
        nvs_set_str(nvs, "last_reason", last_reason);
        nvs_set_i32(nvs, "last_ok", success);
        nvs_set_i32(nvs, "last_on", last_was_on);
        (void)nvs_commit(nvs);
        nvs_close(nvs);
    }
    ack(uuid, device, success, reason);
}

static const char *string_field(const cJSON *json, const char *key)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, key);
    return cJSON_IsString(item) ? item->valuestring : NULL;
}

static bool int_field(const cJSON *json, const char *key, int *out)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, key);
    if (!cJSON_IsNumber(item) || !isfinite(item->valuedouble) ||
        item->valuedouble != (double)item->valueint) return false;
    *out = item->valueint;
    return true;
}

static bool bool_field(const cJSON *json, const char *key, bool *out)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, key);
    if (!cJSON_IsBool(item)) return false;
    *out = cJSON_IsTrue(item);
    return true;
}

static bool belongs_to_node(const char *code, const char *type, int pin)
{
    if (!code || !type) return false;
    if (!strcmp(code, provision.pump_code)) return !strcmp(type, "PUMP") && pin == 26;
    if (!strcmp(code, provision.soil_code)) return !strcmp(type, "SENSOR") && pin == 34;
    if (!strcmp(code, provision.dht_code)) return !strcmp(type, "SENSOR") && pin == 4;
    return false;
}

static void handle_config(const cJSON *json, const char *code)
{
    int version, pin;
    const char *type = string_field(json, "type");
    const cJSON *config = cJSON_GetObjectItemCaseSensitive(json, "config");
    bool enabled = false;
    pump_policy_t proposed = policy;
    bool valid = code && !strcmp(code, provision.pump_code) &&
        int_field(json, "gpioPin", &pin) && belongs_to_node(code, type, pin) &&
        int_field(json, "version", &version) && version >= config_version &&
        cJSON_IsObject(config) &&
        bool_field(config, "pumpAutoEnabled", &enabled) &&
        int_field(config, "soilOnPct", &proposed.on_pct) &&
        int_field(config, "soilOffPct", &proposed.off_pct) &&
        int_field(config, "pumpMaxRunSec", &proposed.max_run_sec) &&
        int_field(config, "pumpCooldownSec", &proposed.cooldown_sec);
    proposed.auto_enabled = enabled;
    valid = valid && valid_pump_policy(&proposed);
    if (valid) {
        nvs_handle_t nvs;
        valid = nvs_open("runtime", NVS_READWRITE, &nvs) == ESP_OK;
        if (valid) {
            if (pump_running) pump_off();
            valid = nvs_set_i32(nvs, "version", version) == ESP_OK &&
                nvs_set_i32(nvs, "on_pct", proposed.on_pct) == ESP_OK &&
                nvs_set_i32(nvs, "off_pct", proposed.off_pct) == ESP_OK &&
                nvs_set_i32(nvs, "max_sec", proposed.max_run_sec) == ESP_OK &&
                nvs_set_i32(nvs, "cool_sec", proposed.cooldown_sec) == ESP_OK &&
                nvs_set_i32(nvs, "auto", proposed.auto_enabled) == ESP_OK &&
                nvs_commit(nvs) == ESP_OK;
            nvs_close(nvs);
        }
        if (valid) { policy = proposed; config_version = version; }
    }
    cJSON *response = cJSON_CreateObject();
    cJSON_AddStringToObject(response, "deviceCode", provision.pump_code);
    cJSON_AddNumberToObject(response, "version", valid ? version : -1);
    cJSON_AddBoolToObject(response, "success", valid);
    publish_json(topic_config_ack, response);
}

static void handle_command(const char *data)
{
    cJSON *json = cJSON_Parse(data);
    if (!cJSON_IsObject(json)) { cJSON_Delete(json); return; }
    const char *action = string_field(json, "action");
    const char *code = string_field(json, "deviceCode");
    const char *type = string_field(json, "type");
    const char *uuid = string_field(json, "commandUuid");
    if (!uuid) uuid = string_field(json, "commandId");
    if (action && !strcmp(action, "config")) {
        handle_config(json, code);
        cJSON_Delete(json);
        return;
    }
    int pin;
    bool valid = int_field(json, "gpioPin", &pin) && belongs_to_node(code, type, pin);
    if (valid && action && !strcmp(action, "lifecycle")) {
        const char *state = string_field(json, "lifecycle");
        if (!state) state = string_field(json, "state");
        if (state && (!strcmp(state, "PROVISIONED") || !strcmp(state, "FAULT") ||
                      !strcmp(state, "MAINTENANCE") || !strcmp(state, "DECOMMISSIONED"))) {
            if (!strcmp(code, provision.pump_code)) { pump_active = false; pump_off(); }
            if (!strcmp(code, provision.soil_code)) { soil_active = false; pump_active = false; pump_off(); }
            if (!strcmp(code, provision.dht_code)) dht_active = false;
            if (uuid && strlen(uuid) == 36) remember_ack(uuid, code, true, "inactive");
            cJSON_Delete(json);
            return;
        }
    }
    if (!uuid || strlen(uuid) != 36 || !code || strlen(code) >= sizeof(last_device)) {
        cJSON_Delete(json);
        return;
    }
    for (size_t i = 0; i < SEEN_CAP; i++) {
        if (!strcmp(uuid, seen[i].uuid)) {
            bool same = !strcmp(code, seen[i].device);
            ack(uuid, code, same && seen[i].success && (!seen[i].was_on || pump_running),
                !same ? "device_mismatch" : seen[i].was_on && !pump_running ? "pump_no_longer_on" : seen[i].reason);
            cJSON_Delete(json);
            return;
        }
    }
    if (!strcmp(uuid, last_uuid)) {
        bool same = !strcmp(code, last_device);
        ack(uuid, code, same && last_success && (!last_was_on || pump_running),
            !same ? "device_mismatch" : last_was_on && !pump_running ? "pump_no_longer_on" : last_reason);
        cJSON_Delete(json);
        return;
    }
    bool success = false;
    const char *reason = "invalid_device_or_command";
    if (valid && action && !strcmp(action, "lifecycle")) {
        const char *state = string_field(json, "lifecycle");
        if (!state) state = string_field(json, "state");
        if (state && !strcmp(state, "ACTIVE")) {
            if (!strcmp(code, provision.pump_code)) {
                success = connected && config_version > 0 && soil_valid && soil_active && !pump_running;
                if (success) pump_active = true;
                reason = success ? "active" : "config_or_soil_not_ready";
            } else {
                success = connected && (!strcmp(code, provision.soil_code) ? soil_valid : dht_valid);
                if (success) {
                    if (!strcmp(code, provision.soil_code)) soil_active = true;
                    else dht_active = true;
                }
                reason = success ? "active" : "sensor_not_ready";
            }
        }
    } else if (valid && action && !strcmp(action, "pump") &&
               !strcmp(code, provision.pump_code)) {
        bool on;
        if (bool_field(json, "on", &on)) {
            if (!on) { pump_off(); success = true; reason = "off"; }
            else {
                int seconds;
                if (!int_field(json, "seconds", &seconds)) seconds = 10;
                success = pump_on(seconds);
                reason = success ? "on" : "inactive_sensor_cooldown_or_limit";
            }
        }
    }
    remember_ack(uuid, code, success, reason);
    cJSON_Delete(json);
}

static void mqtt_handler(void *arg, esp_event_base_t base, int32_t id, void *event_data)
{
    esp_mqtt_event_handle_t event = event_data;
    if (id == MQTT_EVENT_CONNECTED) {
        connected = true;
        esp_mqtt_client_subscribe(mqtt, topic_cmd, 1);
        publish(topic_status, "online");
        ESP_LOGI(TAG, "MQTT connected: %s", provision.node);
    } else if (id == MQTT_EVENT_DISCONNECTED) {
        connected = false;
        pump_active = soil_active = dht_active = false;
        pump_off();
        ESP_LOGW(TAG, "MQTT disconnected; relay OFF");
    } else if (id == MQTT_EVENT_DATA) {
        if (event->total_data_len > COMMAND_MAX || event->current_data_offset < 0 ||
            event->current_data_offset + event->data_len > COMMAND_MAX) {
            command_total = 0;
            return;
        }
        if (event->current_data_offset == 0) {
            command_total = event->total_data_len;
            if (event->topic_len <= 0 || event->topic_len >= sizeof(command_topic)) {
                command_total = 0;
                return;
            }
            memcpy(command_topic, event->topic, event->topic_len);
            command_topic[event->topic_len] = 0;
        }
        if (!command_total || strcmp(command_topic, topic_cmd)) return;
        memcpy(command_data + event->current_data_offset, event->data, event->data_len);
        if (event->current_data_offset + event->data_len == command_total) {
            command_data[command_total] = 0;
            handle_command(command_data);
            command_total = 0;
        }
    }
}

static void wifi_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
    else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        connected = false;
        pump_active = soil_active = dht_active = false;
        pump_off();
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP && !mqtt) {
        esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
        esp_sntp_setservername(0, "pool.ntp.org");
        esp_sntp_init();
        esp_mqtt_client_config_t cfg = {
            .broker.address.uri = provision.broker,
            .credentials.client_id = provision.node,
            .credentials.username = provision.mqtt_user,
            .credentials.authentication.password = provision.mqtt_pass,
            .session.last_will.topic = topic_status,
            .session.last_will.msg = "offline",
            .session.last_will.qos = 1,
            .session.last_will.retain = 0,
            .network.timeout_ms = 10000,
            .buffer.size = 4096,
        };
        if (provision.ca_pem[0]) cfg.broker.verification.certificate = provision.ca_pem;
        else cfg.broker.verification.crt_bundle_attach = esp_crt_bundle_attach;
        mqtt = esp_mqtt_client_init(&cfg);
        if (mqtt) {
            esp_mqtt_client_register_event(mqtt, ESP_EVENT_ANY_ID, mqtt_handler, NULL);
            esp_mqtt_client_start(mqtt);
        }
    }
}

static void backlog_add(char *text)
{
    if (backlog_len == BACKLOG_CAP) {
        free(backlog[backlog_head]);
        backlog_head = (backlog_head + 1) % BACKLOG_CAP;
        backlog_len--;
        dropped++;
    }
    backlog[(backlog_head + backlog_len) % BACKLOG_CAP] = text;
    backlog_len++;
}

static void backlog_flush(void)
{
    while (connected && backlog_len) {
        if (publish(topic_backfill, backlog[backlog_head]) < 0) return;
        free(backlog[backlog_head]);
        backlog_head = (backlog_head + 1) % BACKLOG_CAP;
        backlog_len--;
    }
}

static void send_telemetry(void)
{
    cJSON *json = cJSON_CreateObject();
    cJSON_AddNumberToObject(json, "seq", ++sequence);
    cJSON_AddNumberToObject(json, "bc", boot_counter);
    cJSON_AddNumberToObject(json, "up", now_ms());
    time_t epoch = time(NULL);
    if (epoch > 1700000000) cJSON_AddNumberToObject(json, "ts", (double)epoch * 1000);
    else cJSON_AddNumberToObject(json, "ts", 0);
    cJSON_AddBoolToObject(json, "pumpOn", pump_running);
    cJSON *readings = cJSON_AddArrayToObject(json, "readings");
    if (soil_valid) {
        cJSON *reading = cJSON_CreateObject();
        cJSON_AddStringToObject(reading, "deviceCode", provision.soil_code);
        cJSON_AddStringToObject(reading, "metric", "SOIL_MOISTURE");
        cJSON_AddNumberToObject(reading, "value", soil_pct);
        cJSON_AddItemToArray(readings, reading);
    }
    if (dht_valid) {
        cJSON *reading = cJSON_CreateObject();
        cJSON_AddStringToObject(reading, "deviceCode", provision.dht_code);
        cJSON_AddStringToObject(reading, "metric", "AIR_TEMPERATURE");
        cJSON_AddNumberToObject(reading, "value", temp_c);
        cJSON_AddItemToArray(readings, reading);
        reading = cJSON_CreateObject();
        cJSON_AddStringToObject(reading, "deviceCode", provision.dht_code);
        cJSON_AddStringToObject(reading, "metric", "AIR_HUMIDITY");
        cJSON_AddNumberToObject(reading, "value", humidity_pct);
        cJSON_AddItemToArray(readings, reading);
    }
    char *text = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!text) return;
    if (!connected || publish(topic_telemetry, text) < 0) backlog_add(text);
    else free(text);
}

static void send_heartbeat(void)
{
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "firmwareVersion", FW_VERSION);
    cJSON_AddNumberToObject(json, "bc", boot_counter);
    cJSON_AddNumberToObject(json, "up", now_ms());
    cJSON_AddNumberToObject(json, "dropped", dropped);
    cJSON *faults = cJSON_AddArrayToObject(json, "faults");
    if (!soil_valid) cJSON_AddItemToArray(faults, cJSON_CreateString("soil"));
    if (!dht_valid) cJSON_AddItemToArray(faults, cJSON_CreateString("dht11"));
    publish_json(topic_heartbeat, json);
}

static void sensor_task(void *arg)
{
    int64_t telemetry_at = 0, heartbeat_at = 0;
    while (true) {
        int64_t now = now_ms();
        if (now - last_sample_ms >= SAMPLE_MS) {
            last_sample_ms = now;
            soil_valid = soil_read_raw(&soil_raw);
            if (soil_valid) {
                soil_pct = soil_percent(soil_raw, provision.dry_raw, provision.wet_raw);
                soil_valid = soil_pct >= 0;
                ESP_LOGI(TAG, "soil adc=%d percent=%d", soil_raw, soil_pct);
            }
            dht_valid = dht11_read(&temp_c, &humidity_pct);
            if (!soil_valid) { soil_active = false; pump_active = false; pump_off(); }
            if (!dht_valid) dht_active = false;
            if (soil_valid != !soil_fault_reported) {
                status_event(soil_valid ? "sensor_recovered" : "sensor_fault", "soil",
                    soil_valid ? "soil sensor recovered" : "soil sensor unavailable");
                soil_fault_reported = !soil_valid;
            }
            if (dht_valid != !dht_fault_reported) {
                status_event(dht_valid ? "sensor_recovered" : "sensor_fault", "dht11",
                    dht_valid ? "DHT11 recovered" : "DHT11 unavailable");
                dht_fault_reported = !dht_valid;
            }
        }
        now = now_ms();
        if (pump_running && (!connected || !pump_active || !soil_valid || !soil_active ||
            now >= pump_deadline_ms ||
            now - pump_started_ms >= (int64_t)policy.max_run_sec * 1000 ||
            should_auto_stop(&policy, soil_valid, soil_pct))) pump_off();
        if (should_auto_start(&policy, pump_active, connected, soil_valid, soil_pct,
                              pump_running, pump_stopped_ms ?
                              (int64_t)policy.cooldown_sec * 1000 - (now - pump_stopped_ms) : 0)) {
            (void)pump_on(policy.max_run_sec);
        }
        if (now - telemetry_at >= TELEMETRY_MS) { send_telemetry(); telemetry_at = now; }
        if (now - heartbeat_at >= HEARTBEAT_MS) { send_heartbeat(); heartbeat_at = now; }
        backlog_flush();
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}

void app_main(void)
{
    // Set the physical output OFF before Wi-Fi, NVS, or any other initialization.
    gpio_config_t relay = { .pin_bit_mask = 1ULL << PUMP_PIN, .mode = GPIO_MODE_OUTPUT };
    gpio_set_level(PUMP_PIN, !PUMP_ON_LEVEL);
    gpio_config(&relay);
    pump_off();
    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK) { ESP_LOGE(TAG, "NVS unavailable: %s", esp_err_to_name(err)); return; }
    if (!load_provision()) {
        ESP_LOGE(TAG, "Provision first with tools/provision.py; relay remains OFF");
        return;
    }
    load_state();
    snprintf(topic_cmd, sizeof(topic_cmd), "%s/%s/cmd", provision.prefix, provision.node);
    snprintf(topic_status, sizeof(topic_status), "%s/%s/status", provision.prefix, provision.node);
    snprintf(topic_telemetry, sizeof(topic_telemetry), "%s/%s/telemetry", provision.prefix, provision.node);
    snprintf(topic_backfill, sizeof(topic_backfill), "%s/%s/telemetry/backfill", provision.prefix, provision.node);
    snprintf(topic_heartbeat, sizeof(topic_heartbeat), "%s/%s/heartbeat", provision.prefix, provision.node);
    snprintf(topic_ack, sizeof(topic_ack), "%s/%s/cmd/ack", provision.prefix, provision.node);
    snprintf(topic_config_ack, sizeof(topic_config_ack), "%s/%s/config/ack", provision.prefix, provision.node);
    sensors_init();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t wifi_init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wifi_init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_handler, NULL));
    wifi_config_t wifi = {0};
    snprintf((char *)wifi.sta.ssid, sizeof(wifi.sta.ssid), "%s", provision.wifi_ssid);
    snprintf((char *)wifi.sta.password, sizeof(wifi.sta.password), "%s", provision.wifi_pass);
    wifi.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi));
    xTaskCreate(sensor_task, "sensors", 6144, NULL, 4, NULL);
    ESP_ERROR_CHECK(esp_wifi_start());
}
