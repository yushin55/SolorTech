import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DesignEditor } from "../src/Editors";
import type { Catalog, CatalogInverter, CatalogModule, Design } from "../src/types";

afterEach(cleanup);

const modules: CatalogModule[] = [
  { id: "senergy_sl85_66hdx_730u", label: "에스에너지 730", manufacturer: "에스에너지", series: "SL85-66HDX-730U",
    module_power_w: 730, module_width_m: 1.303, module_height_m: 2.384, thickness_mm: 33, gamma_pdc: -.0024,
    module_price: 365000, price_basis: "사용자 제공 표의 가정 단가", source: "사용자 제공 모듈 비교표",
    missing_electrical: ["vmp_v", "voc_v", "voltage_temp_coeff_pct"] },
  { id: "ls_pvm_s350f4b", label: "LS 350", manufacturer: "LS ELECTRIC", series: "PVM-S350F4B",
    module_power_w: 350, module_width_m: .996, module_height_m: 1.972, module_price: 175000,
    price_basis: "사용자 제공 표의 가정 단가", source: "사용자 제공 모듈 비교표",
    missing_electrical: ["vmp_v", "voc_v", "voltage_temp_coeff_pct", "gamma_pdc"] },
  { id: "lg_lg340s2w_w4", label: "LG 340", manufacturer: "LG전자", series: "LG340S2W-W4",
    module_power_w: 340, module_width_m: 1., module_height_m: 1.96, thickness_mm: 46, gamma_pdc: -.0042,
    module_price: 170000, price_basis: "사용자 제공 표의 가정 단가", source: "사용자 제공 모듈 비교표",
    missing_electrical: ["vmp_v", "voc_v", "voltage_temp_coeff_pct"] },
];
const inverter: CatalogInverter = {
  id: "dass_dsp_33125kshk_nj1", manufacturer: "다쓰테크", model: "DSP-33125KSHK-(NJ1)", kw: 125,
  rating: "125 kW · 380 Vac · 3상 4선식 · 60 Hz", max_efficiency_pct: 98, max_efficiency_qualifier: "이상",
  euro_efficiency_pct: null, certified_efficiency_pct: 97.61, mppt: 1, channels: 1, requires_combiner: true,
  weight_kg: 150, size_mm: "950 × 914 × 362.5", features: ["외부 접속반 필요"], unit_cost: 18750000,
  price_basis: "환산 단가 (견적 가정)", source: "사용자 제공 PDF", warranty: null,
  mppt_min_v: 200, mppt_max_v: 800, full_power_mppt_min_v: 395, max_dc_voltage_v: 1000,
  warnings: ["외부 접속반 수량·비용은 별도 견적이 필요합니다."],
};
const catalog: Catalog = { modules, inverters: [inverter], guideline: "test", defaults: { equipment: {}, costs: {}, finance: {} } };
function design(module: CatalogModule): Design {
  return { id: "d", project_id: "p", candidate_id: "c", name: "장비 검토", costs: {}, finance: {}, equipment: {
    module_preset: module.id, inverter_model: inverter.id, capacity_mode: "count", module_count: 100,
    array_rows: 1, spacing_mode: "guideline", inverter_configuration: "auto", energy_basis: "physics",
    system_loss_pct: 14, vmp_v: 44.81, voc_v: 53.61, voltage_temp_coeff_pct: -.27,
    gamma_pdc: -.0035, inverter_efficiency: .96,
  } };
}

it.each(modules)("keeps missing specs editable for $series and displays supplied values without fabricated photos", (module) => {
  const onChange = vi.fn();
  render(<DesignEditor design={design(module)} context={{ modules: catalog.modules, inverters: catalog.inverters }}
    onChange={onChange} onSave={() => {}} dirty={false} saving={false} />);
  expect(screen.getAllByText(module.label).length).toBeGreaterThan(0);
  expect(screen.getByText(`${module.module_power_w} W`)).toBeTruthy();
  expect(screen.getByText(`${module.module_price.toLocaleString("en-US")}원/장`)).toBeTruthy();
  expect(screen.queryAllByRole("img")).toHaveLength(0);
  expect(document.body.textContent).not.toMatch(/undefined|null%/);
  fireEvent.click(screen.getByText("전기 사양·발전량 모델 (고급)"));
  const vmp = screen.getByRole("spinbutton", { name: "모듈 최대전압 Vmp" });
  fireEvent.change(vmp, { target: { value: "39" } });
  expect(onChange.mock.lastCall?.[0].equipment.vmp_v).toBe(39);
  const gamma = screen.queryByRole("spinbutton", { name: "출력 온도계수 · 물리 모델" });
  expect(Boolean(gamma)).toBe(module.gamma_pdc == null);
});

it("separates NJ1 certified efficiency from the editable calculation assumption and exposes its wiring limits", () => {
  const onChange = vi.fn();
  render(<DesignEditor design={design(modules[0])} context={{ modules: catalog.modules, inverters: catalog.inverters }}
    onChange={onChange} onSave={() => {}} dirty={false} saving={false} />);
  expect(screen.getByText("97.61% (유로효율로 사용 안 함)")).toBeTruthy();
  expect(screen.getByText("200~800 V / 395~800 V")).toBeTruthy();
  expect(screen.getByText("외부 접속반 수량·비용은 별도 견적이 필요합니다.")).toBeTruthy();
  fireEvent.click(screen.getByText("전기 사양·발전량 모델 (고급)"));
  const efficiency = screen.getByRole("spinbutton", { name: "계산용 인버터 효율 · 유로효율 미확인" });
  expect((efficiency as HTMLInputElement).value).toBe("0.96");
  fireEvent.change(efficiency, { target: { value: "0.953" } });
  expect(onChange.mock.lastCall?.[0].equipment.inverter_efficiency).toBe(.953);
});
