"""Unlevered, pre-tax end-of-year project cash flows, all amounts in KRW.

Follows the guideline tool's 예상수익 → 재무성 분석 steps: inflow present value
(유입 현재가치), outflow present value (유출 현재가치), NPV, IRR and B/C, plus the
proposal's required sale price at which B/C equals 1.
"""

import numpy as np
from scipy.optimize import brentq

from .common import integer, number


def _irr(cashflows):
    """Return the unique real rate > -100%; ambiguous/no roots return None.

    Scan log(1+r), then bracket with Brent; scaled exponentials avoid overflow
    when replacement years introduce additional sign changes in cash flows.
    """
    amounts = np.asarray(cashflows, dtype=float)
    if not np.any(amounts < 0) or not np.any(amounts > 0):
        return None
    periods = np.arange(len(amounts))

    def scaled_npv(log_rate):
        exponents = -periods * log_rate
        return float(np.dot(amounts, np.exp(exponents - np.max(exponents))))

    # A project IRR outside (-99.999999%, 100000000%) is not meaningful here.
    samples = np.unique(np.append(np.linspace(np.log(1e-8), np.log(1e6), 1601), 0.0))
    values = [scaled_npv(sample) for sample in samples]
    roots = []
    for index, value in enumerate(values):
        if value == 0:
            roots.append(float(samples[index]))
        elif index and np.signbit(value) != np.signbit(values[index - 1]) and values[index - 1] != 0:
            roots.append(float(brentq(scaled_npv, samples[index - 1], samples[index], xtol=1e-13)))
    distinct = []
    for root in roots:
        if not any(abs(root - previous) < 1e-7 for previous in distinct):
            distinct.append(root)
    if len(distinct) != 1:
        return None
    return float(np.expm1(distinct[0]) * 100)


def sale_price(finance):
    """KRW/kWh for exported energy. REC inputs are KRW/REC (1 MWh) × weight."""
    mode = finance.get("sale_mode", "fixed")
    if mode == "fixed":
        return number(finance, "fixed_price", default=150, minimum=0)
    if mode == "smp_rec":
        return number(finance, "smp_price", default=100, minimum=0) + number(
            finance, "rec_price", default=70000, minimum=0) / 1000 * number(finance, "rec_weight", default=1, minimum=0)
    raise ValueError("sale_mode: fixed 또는 smp_rec이어야 합니다.")


def calculate_finance(annual_kwh, capex, costs, finance, purpose="sale"):
    """Cash flows, PVs, NPV, IRR, B/C, payback and the B/C = 1 required price.

    ``purpose`` "self" (소내소비용) values energy used on site at the retail
    tariff and sells only the surplus (guideline 부록 2.6). Initial CAPEX is
    deducted in year zero only; financing, tax, inflation, subsidies and
    terminal value are excluded.
    """
    annual_kwh = number({"annual_kwh": annual_kwh}, "annual_kwh", minimum=0)
    capex = number({"capex": capex}, "capex", minimum=0)
    opex = number(costs, "annual_om", default=0, minimum=0)
    replacement_cost = number(costs, "replacement_cost", default=0, minimum=0)
    replacement_year = integer(costs, "replacement_year", default=12, minimum=1, maximum=100)
    years = integer(finance, "years", default=20, minimum=1, maximum=100)
    discount = number(finance, "discount_pct", default=4.5, minimum=-99, maximum=100) / 100
    degradation = number(finance, "degradation_pct", default=.5, minimum=0, maximum=100) / 100
    curtailment = number(finance, "curtailment_pct", default=0, minimum=0, maximum=100) / 100
    price = sale_price(finance)
    self_use = number(finance, "self_use_kwh", default=0, minimum=0) if purpose == "self" else 0.
    retail = number(finance, "retail_price", default=0, minimum=0) if purpose == "self" else 0.
    flows = [{"year": 0, "generation_kwh": 0., "sales_kwh": 0., "self_use_kwh": 0., "revenue": 0.,
              "opex": 0., "replacement": 0., "net": -capex, "discounted_net": -capex, "cumulative": -capex}]
    discounted_benefits = 0.
    discounted_costs = capex
    discounted_energy = 0.
    cumulative = -capex
    payback = 0. if capex == 0 else None
    for year in range(1, years + 1):
        generation = annual_kwh * (1 - degradation) ** (year - 1)
        delivered = generation * (1 - curtailment)
        used = min(delivered, self_use)
        sales = delivered - used
        revenue = sales * price + used * retail
        replacement = replacement_cost if year == replacement_year else 0.
        net = revenue - opex - replacement
        discount_factor = (1 + discount) ** year
        previous = cumulative
        cumulative += net
        if payback is None and previous < 0 <= cumulative and net > 0:
            payback = (year - 1) + (-previous / net)
        discounted_benefits += revenue / discount_factor
        discounted_costs += (opex + replacement) / discount_factor
        discounted_energy += delivered / discount_factor
        flows.append({"year": year, "generation_kwh": generation, "sales_kwh": sales, "self_use_kwh": used,
                      "revenue": revenue, "opex": opex, "replacement": replacement, "net": net,
                      "discounted_net": net / discount_factor, "cumulative": cumulative})
    irr = _irr([row["net"] for row in flows])
    warnings = []
    if irr is None:
        warnings.append("유일한 IRR 해를 확인할 수 없어 IRR을 표시하지 않습니다.")
    if replacement_cost > 0 and replacement_year > years:
        warnings.append("교체시점이 사업기간 이후이므로 기간 내 현금흐름에 포함하지 않았습니다.")
    bc = discounted_benefits / discounted_costs if discounted_costs > 0 else None
    if bc is None:
        warnings.append("할인 비용 합계가 0이어서 B/C를 계산할 수 없습니다.")
    # Price that makes discounted revenue equal discounted cost over all delivered kWh.
    required = discounted_costs / discounted_energy if discounted_energy > 0 else None
    return {
        "capex": capex, "annual_opex": opex,
        "first_year_sales_kwh": flows[1]["sales_kwh"] if years else 0.,
        "first_year_self_use_kwh": flows[1]["self_use_kwh"] if years else 0.,
        "first_year_revenue": flows[1]["revenue"] if years else 0.,
        "pv_inflow": discounted_benefits, "pv_outflow": discounted_costs,
        "npv": discounted_benefits - discounted_costs, "bc": bc,
        "irr_pct": irr, "payback_years": payback, "cashflows": flows,
        "effective_price_per_kwh": price, "required_price_per_kwh": required,
        "warnings": warnings,
    }
