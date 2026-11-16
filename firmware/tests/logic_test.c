#include <assert.h>
#include "logic.h"

int main(void)
{
    pump_policy_t p = { true, 35, 60, 30, 60 };
    assert(soil_percent(3000, 3000, 1000) == 0);
    assert(soil_percent(1000, 3000, 1000) == 100);
    assert(soil_percent(2000, 3000, 1000) == 50);
    assert(soil_percent(500, 3000, 1000) == 100);
    assert(soil_percent(2500, 1000, 3000) == 75);
    assert(soil_percent(1234, 1234, 1234) == -1);
    assert(valid_pump_policy(&p));
    assert(should_auto_start(&p, true, true, true, 35, false, 0));
    assert(!should_auto_start(&p, false, true, true, 20, false, 0));
    assert(!should_auto_start(&p, true, false, true, 20, false, 0));
    assert(!should_auto_start(&p, true, true, false, 20, false, 0));
    assert(!should_auto_start(&p, true, true, true, 20, false, 1));
    assert(should_auto_stop(&p, true, 60));
    assert(!should_auto_stop(&p, false, 90));
    p.max_run_sec = 31;
    assert(!valid_pump_policy(&p));
    return 0;
}
