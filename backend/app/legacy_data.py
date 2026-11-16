"""Read old local projects through the team schema without migrating the database."""
from copy import deepcopy

from .schemas import Costs, Equipment, Finance


def readable(kind, record):
    if kind not in ("candidates", "designs"):
        return record
    result = deepcopy(record)
    if kind == "candidates":
        if result.get("site_type") == "rooftop":
            result["site_type"] = "building"
        # The team schema stores shading on equipment, not on a candidate.
        result.pop("shading_loss_pct", None)
        return result
    equipment = result.get("equipment", {})
    # This discontinued local preset is kept as editable source data, not offered
    # as another new catalog product in the team interface.
    if equipment.get("module_preset") == "hd_his_t650uj":
        equipment.update(module_preset="custom", module_model="HD현대 HiS-T650UJ-ES",
                         module_manufacturer="HD현대에너지솔루션", module_power_w=650,
                         module_width_m=1.134, module_height_m=2.465, module_price=325000,
                         vmp_v=47.75, voc_v=57.69, voltage_temp_coeff_pct=-.25, gamma_pdc=-.0029)
    equipment["capacity_mode"] = {"target": "capacity", "area_input": "site_area"}.get(
        equipment.get("capacity_mode"), equipment.get("capacity_mode", "count"))
    for group, schema in (("equipment", Equipment), ("costs", Costs), ("finance", Finance)):
        previous = result.get(group, {})
        result[group] = {key: value for key, value in previous.items() if key in schema.model_fields}
    return result
