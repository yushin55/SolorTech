import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, num } from "./api";
import { MODEL_NAMES, Term, axis, series, tooltipStyle } from "./Steps";
import type {
  CalibrationSummary,
  Plant,
  PlantDetail,
  PlantList,
  PredictionRow,
  WeatherCheck,
} from "./types";

const FLAG: Record<string, string> = {
  ok: "정상",
  zero: "0 kWh (정지·통신 장애)",
  spike: "급등 (계량 몰아치기)",
  missing: "결측",
};
const ym = (year: number, month: number) =>
  `${String(year).slice(2)}.${String(month).padStart(2, "0")}`;

function plantStatus(p: Plant) {
  if (p.outlier) return "제원 확인 필요 · 학습 제외";
  if (!p.train_months) return "학습 자료 없음";
  return `학습 ${p.train_months}개월`;
}

export function PlantRecords({ onError }: { onError: (e: unknown) => void }) {
  const [list, setList] = useState<PlantList | null>(null);
  const [selected, setSelected] = useState("asan-2");
  const [detail, setDetail] = useState<PlantDetail | null>(null);
  useEffect(() => {
    api<PlantList>("/plants").then(setList).catch(onError);
  }, [onError]);
  useEffect(() => {
    if (!selected) return;
    setDetail(null);
    api<PlantDetail>(`/plants/${selected}`).then(setDetail).catch(onError);
  }, [selected, onError]);
  const monthly = useMemo(
    () =>
      detail?.monthly.map((m) => ({
        label: ym(m.year, m.month),
        measured: m.usable ? m.measured_kwh / 1000 : null,
        physics: m.usable ? m.physics_kwh / 1000 : null,
      })) || [],
    [detail],
  );
  const daily = useMemo(
    () =>
      detail?.daily.map((d) => ({
        date: d.date,
        measured: d.flag === "ok" ? d.measured : null,
        physics: d.physics,
      })) || [],
    [detail],
  );
  const flagged = detail?.daily.filter((d) => d.flag !== "ok") || [];
  if (!list) return <div className="card empty">운영실적을 불러오는 중…</div>;
  if (!list.plants.length)
    return (
      <div className="card empty">
        <h3>가져온 운영실적이 없습니다</h3>
        <p>
          backend에서 <code>scripts/import_data.py</code>와{" "}
          <code>scripts/build_calibration.py</code>를 실행하세요.
        </p>
      </div>
    );
  const plant = list.plants.find((p) => p.id === selected);
  const excluded = list.plants.reduce((sum, p) => sum + (p.zero_days || 0) + (p.spike_days || 0), 0);
  const usable = list.plants.reduce((sum, p) => sum + (p.usable_months || 0), 0);
  const floating = list.plants.filter((p) => p.type === "floating").length;
  return (
    <div className="stack">
      <div className="card lead">
        <h3>이 데이터로 무엇을 하나요?</h3>
        <p>
          K-water가 실제로 운영 중인 발전소의 매일 기록입니다. 같은 날짜의 기상으로 계산한 물리 모델
          값과 나란히 놓아, 모델이 실제보다 얼마나 높게·낮게 예측하는지 확인하고 그 차이를 보정 모델이
          학습합니다. 정지(0 kWh)나 계량 몰아치기(급등)처럼 날씨와 무관한 기록은 먼저 걸러냅니다.
        </p>
      </div>
      <div className="kpis">
        <div>
          <span>운영 발전소</span>
          <strong>
            {list.plants.length}
            <small>곳</small>
          </strong>
          <small>수상 {floating}곳 포함 · 아산 발전량 + 26곳 거래량</small>
        </div>
        <div>
          <span>비교 가능한 월</span>
          <strong>
            {num(usable)}
            <small>개월</small>
          </strong>
          <small>유효일 80% 이상인 발전소-월</small>
        </div>
        <div>
          <span>걸러낸 날</span>
          <strong>
            {num(excluded)}
            <small>일</small>
          </strong>
          <small>0 kWh 정지·급등(몰아치기)</small>
        </div>
        <div>
          <span>기록 기간</span>
          <strong className="text">2023-01 ~ 2026-07</strong>
          <small>아산은 2023-04부터</small>
        </div>
      </div>
      <div className="card">
        <div className="card-heading">
          <h3>K-water 운영 발전소 {list.plants.length}곳</h3>
          <span className="muted">
            아산 월간보고서(일 발전량) · 발전원별 정산내역(일 전력거래량)
          </span>
        </div>
        <div className="table-scroll">
          <table className="selectable">
            <thead>
              <tr>
                <th>발전소</th>
                <th>유형</th>
                <th>용량 kW</th>
                <th>kWh/kWp·년</th>
                <th>실측 ÷ 물리</th>
                <th>보정 학습</th>
              </tr>
            </thead>
            <tbody>
              {list.plants.map((p) => (
                <tr
                  key={p.id}
                  className={p.id === selected ? "active" : ""}
                  onClick={() => setSelected(p.id)}
                >
                  <th>
                    <button className="link" onClick={() => setSelected(p.id)}>
                      {p.name}
                    </button>
                  </th>
                  <td>{p.type_label}</td>
                  <td>{num(p.capacity_kw, 1)}</td>
                  <td>{num(p.specific_yield)}</td>
                  <td>{num(p.ratio, 3)}</td>
                  <td className={p.outlier ? "bad" : ""}>{plantStatus(p)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          품질 규칙: 일 {list.qc.spike_kwh_per_kwp} kWh/kWp 초과는 급등, 0 kWh는
          정지로 제외 · 월 유효일 {num(list.qc.min_month_coverage * 100)}% 이상만
          비교 · 발전소 중앙값의 {num(list.qc.availability_factor * 100)}% 미만인 월은
          부분 정지 의심으로 제외 · 전체 중앙값의{" "}
          {num(list.qc.plant_outlier_factor * 100)}% 미만 발전소는 제원 확인 전까지
          학습 제외. 물리값은 {list.weather_source}로 같은 날짜를 계산한 값입니다.
        </p>
      </div>
      {plant && (
        <div className="card">
          <div className="card-heading">
            <h3>{plant.name}</h3>
            <span className="muted">
              {num(plant.capacity_kw, 1)} kW · {plant.source}
            </span>
          </div>
          <dl className="facts">
            <div>
              <dt>자료</dt>
              <dd>{plant.data_kind === "generation" ? "인버터 발전량" : "전력거래량(정산)"}</dd>
            </div>
            <div>
              <dt>기간</dt>
              <dd>
                {plant.first} ~ {plant.last}
              </dd>
            </div>
            <div>
              <dt>비교 가능한 월</dt>
              <dd>
                {plant.usable_months} / {plant.months}
              </dd>
            </div>
            <div>
              <dt>걸러낸 날</dt>
              <dd>
                정지 {num(plant.zero_days)}일 · 급등 {num(plant.spike_days)}일
              </dd>
            </div>
          </dl>
          <p className="hint">
            위치·경사는 가정값입니다: {plant.coordinate_basis} · {plant.orientation_basis} ({plant.tilt}°)
          </p>
          {!detail ? (
            <div className="inline-empty">불러오는 중…</div>
          ) : (
            <>
              <h4>월별 실측과 물리 모델 (유효일만, MWh)</h4>
              <div className="chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={monthly} margin={{ top: 12, right: 12, left: -8 }}>
                    <CartesianGrid vertical={false} stroke="#eef0f3" />
                    <XAxis dataKey="label" axisLine={false} tickLine={false} tick={axis} minTickGap={16} />
                    <YAxis axisLine={false} tickLine={false} tick={axis} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(v, name) => [`${num(Number(v), 1)} MWh`, name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line dataKey="measured" name={plant.data_kind === "generation" ? "실측 발전량" : "실측 거래량"} stroke={series[0]} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
                    <Line dataKey="physics" name="물리 모델 (ERA5, 같은 날짜)" stroke={series[2]} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="hint">
                유효일 비율 80% 미만인 월은 선이 끊깁니다. 물리 모델은 보정 전
                값이며, 차이가 곧 보정 대상 오차입니다.
              </p>
              <h4>일별 용량당 발전량 (kWh/kWp)</h4>
              <div className="chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={daily} margin={{ top: 12, right: 12, left: -8 }}>
                    <CartesianGrid vertical={false} stroke="#eef0f3" />
                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={axis} minTickGap={40} />
                    <YAxis axisLine={false} tickLine={false} tick={axis} domain={[0, 8]} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(v, name) => [`${num(Number(v), 2)} kWh/kWp`, name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line dataKey="measured" name="실측 (정상일)" stroke={series[0]} strokeWidth={1} dot={false} connectNulls={false} isAnimationActive={false} />
                    <Line dataKey="physics" name="물리 모델" stroke={series[2]} strokeWidth={1} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <h4>제외한 날 {flagged.length}일</h4>
              <div className="flag-list">
                {Object.entries(
                  flagged.reduce<Record<string, number>>((acc, d) => {
                    acc[d.flag] = (acc[d.flag] || 0) + 1;
                    return acc;
                  }, {}),
                ).map(([flag, count]) => (
                  <span key={flag} className="tag">
                    {FLAG[flag] || flag} {count}일
                  </span>
                ))}
              </div>
              {flagged.some((d) => d.flag === "spike") && (
                <p className="hint">
                  급등일:{" "}
                  {flagged
                    .filter((d) => d.flag === "spike")
                    .map((d) => `${d.date} (${num(d.measured, 1)} kWh/kWp)`)
                    .join(", ")}
                </p>
              )}
              <details className="detail">
                <summary>월별 비교표 보기</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>월</th>
                      <th>유효일</th>
                      <th>실측 MWh</th>
                      <th>물리 MWh</th>
                      <th>실측 ÷ 물리</th>
                      <th>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.monthly.map((m) => (
                      <tr key={`${m.year}-${m.month}`}>
                        <th>
                          {m.year}-{String(m.month).padStart(2, "0")}
                        </th>
                        <td>
                          {m.valid_days}/{m.days}
                        </td>
                        <td>{num(m.measured_kwh / 1000, 1)}</td>
                        <td>{num(m.physics_kwh / 1000, 1)}</td>
                        <td>{num(m.ratio, 3)}</td>
                        <td className={m.train ? "" : "bad"}>
                          {!m.usable
                            ? "유효일 부족"
                            : m.availability_flag
                              ? "부분 정지 의심"
                              : m.train
                                ? "학습·검증"
                                : "발전소 제외"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ModelValidation({ onError }: { onError: (e: unknown) => void }) {
  const [summary, setSummary] = useState<CalibrationSummary | null>(null);
  const [plantId, setPlantId] = useState("");
  const [rows, setRows] = useState<PredictionRow[]>([]);
  useEffect(() => {
    api<CalibrationSummary>("/calibration")
      .then((s) => {
        setSummary(s);
        setPlantId(
          s.per_plant.find((p) => p.plant_id.includes("floating"))?.plant_id ||
            s.per_plant[0]?.plant_id ||
            "",
        );
      })
      .catch(onError);
  }, [onError]);
  useEffect(() => {
    if (!plantId) return;
    api<PredictionRow[]>(`/calibration/predictions?plant_id=${encodeURIComponent(plantId)}`)
      .then(setRows)
      .catch(onError);
  }, [plantId, onError]);
  if (!summary) return <div className="card empty">보정 결과를 불러오는 중…</div>;
  const selected = summary.selected_model;
  const models = Object.entries(summary.models);
  const bars = models.map(([key, m]) => ({
    name: MODEL_NAMES[key] || m.label,
    all: m.all.mape_pct,
    floating: m.floating?.mape_pct ?? null,
  }));
  const plants = summary.per_plant.filter((p) => p.model === selected);
  const physicsByPlant = Object.fromEntries(
    summary.per_plant.filter((p) => p.model === "physics").map((p) => [p.plant_id, p]),
  );
  const chart = rows
    .filter((r) => r.model === selected)
    .map((r) => ({
      label: ym(r.year, r.month),
      measured: r.measured,
      predicted: r.predicted,
      physics: r.physics,
    }));
  const d = summary.dataset;
  const before = summary.models.physics.all.bias_pct;
  return (
    <div className="stack">
      <div className="card lead">
        <h3>한 줄 요약</h3>
        <p>
          물리 모델만 쓰면 실제보다 평균 <b>{num(before, 1)}%</b> 높게 예측합니다. 운영실적으로 보정하면
          학습에 쓰지 않은 발전소의 월 오차(<Term name="MAPE" />)가{" "}
          <b>
            {num(summary.models.physics.all.mape_pct, 1)}% → {num(summary.models[selected].all.mape_pct, 1)}%
          </b>
          로, 수상 발전소는{" "}
          <b>
            {num(summary.models.physics.floating?.mape_pct, 1)}% →{" "}
            {num(summary.models[selected].floating?.mape_pct, 1)}%
          </b>
          로 줄어듭니다. 신규 후보지의 <Term name="P10–P90" /> 범위도 이 검증 결과에서 나옵니다.
        </p>
      </div>
      <div className="card">
        <div className="card-heading">
          <h3>장소 분리 검증 (leave-one-plant-out)</h3>
          <span className="muted">
            {d.period} · 발전소 {d.plants}곳 · 학습·검증 {num(d.train_months)}개월
          </span>
        </div>
        <div className="metrics">
          <div>
            <span>선택 모델</span>
            <strong className="text">{summary.selected_label}</strong>
          </div>
          <div>
            <span>수상 발전소 월 MAPE</span>
            <strong>
              {num(summary.models.physics.floating?.mape_pct, 1)} →{" "}
              {num(summary.models[selected].floating?.mape_pct, 1)}
              <small>%</small>
            </strong>
            <small>물리 모델 단독 → 선택 모델</small>
          </div>
          <div>
            <span>전체 발전소 월 MAPE</span>
            <strong>
              {num(summary.models.physics.all.mape_pct, 1)} →{" "}
              {num(summary.models[selected].all.mape_pct, 1)}
              <small>%</small>
            </strong>
          </div>
          <div>
            <span>연간 오차 범위 (P10–P90)</span>
            <strong>
              {num((summary.band.annual.p10 - 1) * 100, 1)} ~ +
              {num((summary.band.annual.p90 - 1) * 100, 1)}
              <small>%</small>
            </strong>
            <small>실측 ÷ 예측, 발전소 {summary.band.annual.n_plants}곳</small>
          </div>
        </div>
        <p className="hint">{summary.selection_rule}</p>
      </div>
      <div className="split even">
        <div className="card">
          <div className="card-heading">
            <h3>모델별 월 MAPE</h3>
            <span className="muted">학습하지 않은 발전소 기준</span>
          </div>
          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bars} layout="vertical" margin={{ top: 4, right: 16, left: 24 }}>
                <CartesianGrid horizontal={false} stroke="#eef0f3" />
                <XAxis type="number" axisLine={false} tickLine={false} tick={axis} unit="%" />
                <YAxis type="category" dataKey="name" width={170} axisLine={false} tickLine={false} tick={axis} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [`${num(Number(v), 1)}%`, name]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="all" name="전체 발전소" fill={series[0]} radius={[0, 4, 4, 0]} barSize={10} />
                <Bar dataKey="floating" name="수상 발전소" fill={series[1]} radius={[0, 4, 4, 0]} barSize={10} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card">
          <div className="card-heading">
            <h3>모델 비교</h3>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>모델</th>
                  <th>전체 MAPE</th>
                  <th>전체 편향</th>
                  <th>수상 MAPE</th>
                  <th>수상 편향</th>
                </tr>
              </thead>
              <tbody>
                {models.map(([key, m]) => (
                  <tr key={key} className={key === selected ? "active" : ""}>
                    <th>
                      {MODEL_NAMES[key] || m.label}
                      {key === selected && <span className="tag">선택</span>}
                    </th>
                    <td>{num(m.all.mape_pct, 1)}%</td>
                    <td>{num(m.all.bias_pct, 1)}%</td>
                    <td>{num(m.floating?.mape_pct, 1)}%</td>
                    <td>{num(m.floating?.bias_pct, 1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            편향 = 평균(예측 ÷ 실측 − 1). 물리 모델은 실측보다 평균{" "}
            {num(summary.models.physics.all.bias_pct, 1)}% 높게 예측합니다. 수상
            발전소는 {summary.models.physics.floating?.plants ?? 0}곳으로 표본이
            작습니다.
          </p>
          {d.outlier_plants.length > 0 && (
            <p className="inline-warning">
              학습·검증 제외:{" "}
              {d.outlier_plants
                .map(
                  (o) =>
                    `${o.name} (실측÷물리 ${num(o.ratio, 2)}, 전체 중앙값 ${num(o.median_ratio, 2)})`,
                )
                .join(", ")}
              {" "}— 소내 사용·음영·설비 제원 차이를 K-water 제원으로 확인해야 합니다.
            </p>
          )}
        </div>
      </div>
      <div className="card">
        <div className="card-heading">
          <h3>발전소별 재현</h3>
          <select
            aria-label="재현 발전소"
            value={plantId}
            onChange={(e) => setPlantId(e.target.value)}
          >
            {plants.map((p) => (
              <option key={p.plant_id} value={p.plant_id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 12, right: 12, left: -8 }}>
              <CartesianGrid vertical={false} stroke="#eef0f3" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={axis} minTickGap={16} />
              <YAxis axisLine={false} tickLine={false} tick={axis} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [`${num(Number(v), 1)} kWh/kWp`, name]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line dataKey="measured" name="실측" stroke={series[0]} strokeWidth={2} dot={false} />
              <Line dataKey="predicted" name={summary.selected_label} stroke={series[1]} strokeWidth={2} dot={false} />
              <Line dataKey="physics" name="물리 모델 단독" stroke={series[2]} strokeWidth={2} strokeDasharray="5 4" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="hint">
          월별 용량당 발전량(유효일 합계). 이 발전소를 학습에서 뺀 모델의 예측입니다.
        </p>
        <details className="detail">
          <summary>발전소 {plants.length}곳의 오차 표 보기 (행을 누르면 위 그래프가 바뀝니다)</summary>
        <div className="table-scroll">
          <table className="selectable">
            <thead>
              <tr>
                <th>발전소</th>
                <th>물리 MAPE</th>
                <th>선택 모델 MAPE</th>
                <th>MAPE 변화</th>
                <th>기간 합계 오차</th>
                <th>월 수</th>
              </tr>
            </thead>
            <tbody>
              {plants.map((p) => {
                const base = physicsByPlant[p.plant_id];
                return (
                  <tr
                    key={p.plant_id}
                    className={p.plant_id === plantId ? "active" : ""}
                    onClick={() => setPlantId(p.plant_id)}
                  >
                    <th>{p.name}</th>
                    <td>{num(base?.mape_pct, 1)}%</td>
                    <td>{num(p.mape_pct, 1)}%</td>
                    <td className={base && p.mape_pct > base.mape_pct ? "bad" : "good"}>
                      {base ? `${num(p.mape_pct - base.mape_pct, 1)}%p` : "—"}
                    </td>
                    <td>{num(p.plant_total_abs_error_pct, 1)}%</td>
                    <td>{p.months}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </details>
      </div>
      <div className="card">
        <div className="card-heading">
          <h3>월별 오차 범위 (실측 ÷ 예측)</h3>
          <span className="muted">신규 후보지 P10–P90 막대의 근거</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th />
                {Object.keys(summary.band.monthly).map((m) => (
                  <th key={m}>{m}월</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(["p10", "p50", "p90"] as const).map((q) => (
                <tr key={q}>
                  <th>{q.toUpperCase()}</th>
                  {Object.values(summary.band.monthly).map((b, i) => (
                    <td key={i}>{num(b[q], 2)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          {summary.band.basis}. 물리 모델 기준: {summary.physics_reference}. 기상:{" "}
          {summary.weather_source}.
        </p>
      </div>
    </div>
  );
}

export function WeatherValidation({ onError }: { onError: (e: unknown) => void }) {
  const [data, setData] = useState<WeatherCheck | null>(null);
  useEffect(() => {
    api<WeatherCheck>("/weather-check").then(setData).catch(onError);
  }, [onError]);
  if (!data) return <div className="card empty">기상 관측 검증을 불러오는 중…</div>;
  const check = data.irradiance;
  const years = data.long_term_years;
  const monthly =
    check?.monthly.map((m) => ({
      label: `${m.month.slice(2, 4)}.${m.month.slice(5)}`,
      observed: m.observed_kwh_m2,
      reanalysis: m.reanalysis_kwh_m2,
    })) || [];
  const variants = data.variants || {};
  return (
    <div className="stack">
      <div className="card lead">
        <h3>왜 이 화면이 필요한가요?</h3>
        <p>
          발전량 계산의 출발점은 일사량입니다. 전국 어디서나 쓸 수 있는 ERA5 재분석 일사량이
          실제 기상청 일사계 관측과 얼마나 맞는지 확인하고, 계절별 차이를 보정계수로 만들어
          장소 분리 검증에서 오차가 줄어들 때만 사용합니다. 장기 발전량은 기상청 평년과 같은{" "}
          <b>
            {years[0]}~{years.at(-1)}년({years.length}년)
          </b>{" "}
          기상으로 계산합니다(가이드라인 3.5.1 “30년 평균 일사량”).
        </p>
      </div>
      {check ? (
        <>
          <div className="kpis">
            <div>
              <span>비교 관측소</span>
              <strong className="text">
                기상청 {check.station.name} ({check.station.stn})
              </strong>
              <small>
                {check.period} · {num(check.days)}일
              </small>
            </div>
            <div>
              <span>일별 상관계수</span>
              <strong>{num(check.daily_correlation, 3)}</strong>
              <small>1에 가까울수록 날씨 변화를 잘 따라감</small>
            </div>
            <div>
              <span>전체 기간 일사량 비율</span>
              <strong>
                {num((check.overall_ratio - 1) * 100, 1)}
                <small>%</small>
              </strong>
              <small>ERA5 ÷ 관측 − 1 (치우침)</small>
            </div>
            <div>
              <span>보정 사용 여부</span>
              <strong className={"text " + (data.applied ? "good" : "")}>
                {data.applied ? "사용 중" : "사용 안 함"}
              </strong>
              <small>{data.rule}</small>
            </div>
          </div>
          <div className="card">
            <div className="card-heading">
              <h3>월 일사량: 기상청 관측 vs ERA5 (kWh/m²)</h3>
              <span className="source-chip">{check.basis}</span>
            </div>
            <div className="chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={monthly} margin={{ top: 12, right: 12, left: -8 }}>
                  <CartesianGrid vertical={false} stroke="#eef0f3" />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} tick={axis} minTickGap={16} />
                  <YAxis axisLine={false} tickLine={false} tick={axis} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v, name) => [`${num(Number(v), 1)} kWh/m²`, name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line dataKey="observed" name={`기상청 ${check.station.name} 일사계`} stroke={series[0]} strokeWidth={2} dot={{ r: 3 }} />
                  <Line dataKey="reanalysis" name="ERA5 재분석" stroke={series[2]} strokeWidth={2} strokeDasharray="5 4" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="hint">
              여름 장마철(7~8월)에는 ERA5가 실제보다 일사량을 높게, 봄에는 낮게 잡습니다. 아래
              월별 보정계수는 이 차이를 되돌리는 값입니다. 기온은 ERA5가 평균{" "}
              {num(check.temperature_bias_c, 1)}°C 다릅니다.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>월</th>
                    {Object.keys(check.factors).map((m) => (
                      <th key={m}>{m}월</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>보정계수 (관측 ÷ ERA5)</th>
                    {Object.values(check.factors).map((f, i) => (
                      <td key={i} className={Math.abs(f - 1) > 0.05 ? "emph" : ""}>
                        {num(f, 3)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <div className="card-heading">
              <h3>보정계수를 쓸지 정한 방법</h3>
            </div>
            <p>
              같은 K-water 발전소 27곳으로 <Term name="장소 분리 검증" />을 두 번 했습니다. 선택 모델의
              수상 발전소 월 <Term name="MAPE" />:
            </p>
            <div className="compare-bars">
              {Object.entries(variants).map(([key, v]) => (
                <div key={key} className={data.applied === (key === "era5_kma") ? "chosen" : ""}>
                  <span>{v.label}</span>
                  <strong>{num(v.score, 2)}%</strong>
                  {data.applied === (key === "era5_kma") && <em>채택</em>}
                </div>
              ))}
            </div>
            <p className="hint">
              비교 관측소가 서울 1곳이라 계절 보정계수를 전국 후보지에 같게 적용합니다. 다른
              관측소(천안·대전 등) 일사 자료를 추가하면 지역별 보정으로 바꿀 수 있습니다.
            </p>
          </div>
        </>
      ) : (
        <div className="card empty">
          <h3>기상청 일통계 파일이 없습니다</h3>
          <p>
            <code>scripts/import_data.py</code>로 기상청 API 파일을 가져온 뒤{" "}
            <code>scripts/build_calibration.py</code>를 실행하세요.
          </p>
        </div>
      )}
      {data.normals && (
        <div className="card">
          <div className="card-heading">
            <h3>
              기상청 평년값 · {data.normals.station.name} ({data.normals.period})
            </h3>
            <span className="source-chip">60 km 이내 후보지는 ① 단계에서 기온을 비교합니다</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th />
                  {data.normals.months.map((m) => (
                    <th key={m.month}>{m.month}월</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["평균기온 °C", "ta", 1],
                    ["최고기온 °C", "ta_max", 1],
                    ["최저기온 °C", "ta_min", 1],
                    ["상대습도 %", "hm", 0],
                    ["일조시간 h", "ss_hours", 0],
                  ] as const
                ).map(([label, key, digits]) => (
                  <tr key={key}>
                    <th>{label}</th>
                    {data.normals!.months.map((m) => (
                      <td key={m.month}>{num(m[key], digits)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            평년 일조시간은 참고값입니다. ERA5 시간 평균값으로는 일조시간을 정확히 재현할 수 없어
            비교에 쓰지 않고, 일사량은 위의 일사계 관측으로 직접 검증합니다.
          </p>
        </div>
      )}
    </div>
  );
}
