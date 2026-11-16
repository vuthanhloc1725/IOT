#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    bool auto_enabled;
    int on_pct;
    int off_pct;
    int max_run_sec;
    int cooldown_sec;
} pump_policy_t;

int soil_percent(int raw, int dry, int wet);
bool should_auto_start(const pump_policy_t *policy, bool active, bool connected,
                       bool soil_valid, int soil_pct, bool running, int64_t cooldown_left_ms);
bool should_auto_stop(const pump_policy_t *policy, bool soil_valid, int soil_pct);
bool valid_pump_policy(const pump_policy_t *policy);
