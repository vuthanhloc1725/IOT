#include "logic.h"

int soil_percent(int raw, int dry, int wet)
{
    if (dry == wet) return -1;
    int value = (int)(((int64_t)(dry - raw) * 100) / (dry - wet));
    if (value < 0) return 0;
    if (value > 100) return 100;
    return value;
}

bool valid_pump_policy(const pump_policy_t *p)
{
    return p && p->on_pct >= 0 && p->off_pct <= 100 && p->on_pct < p->off_pct &&
           p->max_run_sec >= 1 && p->max_run_sec <= 30 &&
           p->cooldown_sec >= 60 && p->cooldown_sec <= 3600;
}

bool should_auto_start(const pump_policy_t *p, bool active, bool connected,
                       bool soil_valid, int soil_pct, bool running, int64_t cooldown_left_ms)
{
    return valid_pump_policy(p) && p->auto_enabled && active && connected &&
           soil_valid && soil_pct <= p->on_pct && !running && cooldown_left_ms <= 0;
}

bool should_auto_stop(const pump_policy_t *p, bool soil_valid, int soil_pct)
{
    return valid_pump_policy(p) && soil_valid && soil_pct >= p->off_pct;
}
