import { useState } from "react";
import { api, num } from "./api";
import type { Run } from "./types";
type Preview = {
  headers: string[];
  rows: Record<string, unknown>[];
  row_count: number;
};
type ValidationResult = {
  kind: string;
  row_count: number;
  valid_rows: number;
  valid_ratio: number;
  compatible: boolean;
  diagnostics: Record<string, number | string>;
  warnings: string[];
  monthly: {
    month: number;
    period: string;
    actual_kwh: number | null;
    model_kwh: number;
    model_matched_kwh: number | null;
    difference_kwh: number | null;
    relative_error_pct: number | null;
    valid_ratio: number;
    direction: string;
  }[];
};
export default function Validation({
  run,
  runs,
  onError,
}: {
  run: Run | null;
  runs: Run[];
  onError: (e: unknown) => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [runId, setRunId] = useState(run?.id || ""),
    [kind, setKind] = useState("generation"),
    [measurement, setMeasurement] = useState("interval"),
    [unit, setUnit] = useState("kWh"),
    [semantics, setSemantics] = useState("start"),
    [interval, setInterval] = useState(60),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<ValidationResult | null>(null);
  const available =
    run?.result && !runs.some((r) => r.id === run.id) ? [run, ...runs] : runs;
  const fields = [
    ["timestamp", "측정시각 *"],
    ["value", "전력량·계량값 *"],
    ["plant_id", "발전소 ID *"],
    ["capacity_kw", "설비용량 (kW)"],
    ["latitude", "위도"],
    ["longitude", "경도"],
    ["module_power_w", "모듈 정격출력"],
    ["tilt", "경사각"],
    ["azimuth", "방위각"],
  ];
  async function load(f: File) {
    setFile(f);
    setResult(null);
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", f);
      const p = await api<Preview>("/validation/preview", {
        method: "POST",
        body,
      });
      setPreview(p);
      setMapping(
        Object.fromEntries(
          fields.map(([key]) => [key, p.headers.find((h) => h === key) || ""]),
        ),
      );
    } catch (e) {
      setPreview(null);
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  async function validate() {
    if (!file || !preview) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append(
        "mapping",
        JSON.stringify(
          Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
        ),
      );
      body.append("run_id", runId || run?.id || available[0]?.id || "");
      body.append("kind", kind);
      body.append("measurement", measurement);
      body.append("unit", unit);
      body.append("timestamp_semantics", semantics);
      body.append("interval_minutes", String(interval));
      setResult(
        await api<ValidationResult>("/validation", { method: "POST", body }),
      );
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="validation">
      <p className="page-note">
        실제 발전량·판매량·정산량을 구분해 월별로 비교합니다(Asia/Seoul 기준).
        유효 자료가 부족하거나 실적이 0인 달은 상대오차를 계산하지 않습니다.
      </p>
      <div className="validation-grid">
        <section className="card upload-card">
          <div className="card-heading">
            <h3>01. CSV 자료 업로드</h3>
            <span className="badge neutral">최대 5 MB</span>
          </div>
          <label className="upload-zone">
            <strong>{file?.name || "CSV 파일을 선택하세요"}</strong>
            <span>UTF-8 또는 CP949 · 열 매핑 지원</span>
            <input
              type="file"
              accept=".csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void load(f);
              }}
            />
            <b className="btn">파일 선택</b>
          </label>
          <p className="hint">예제 자료: 프로젝트의 examples/ 폴더</p>
          {preview && (
            <>
              <div className="card-heading inner">
                <h3>열 매핑</h3>
                <span className="muted">
                  {num(preview.row_count)}행
                </span>
              </div>
              <div className="fields">
                {fields.map(([key, label]) => (
                  <label className="field" key={key}>
                    <span>{label}</span>
                    <select
                      value={mapping[key] || ""}
                      onChange={(e) =>
                        setMapping({ ...mapping, [key]: e.target.value })
                      }
                    >
                      <option value="">선택 안 함</option>
                      {preview.headers.map((h) => (
                        <option key={h}>{h}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </>
          )}
        </section>
        <section className="card validation-options">
          <div className="card-heading">
            <h3>02. 계량·검증 조건</h3>
          </div>
          <div className="fields">
            <label className="field full">
              <span>비교할 분석 실행</span>
              <select
                value={runId || run?.id || available[0]?.id || ""}
                onChange={(e) => setRunId(e.target.value)}
              >
                {!available.length && (
                  <option value="">분석을 먼저 실행하세요</option>
                )}
                {available.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.snapshot.design.name} · {r.snapshot.candidate.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>계량 종류</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="generation">실제 발전량</option>
                <option value="sales">판매전력량</option>
                <option value="settlement">정산전력량</option>
              </select>
            </label>
            <label className="field">
              <span>계량 방식</span>
              <select
                value={measurement}
                onChange={(e) => setMeasurement(e.target.value)}
              >
                <option value="interval">구간 전력량</option>
                <option value="cumulative">누적 계량값</option>
              </select>
            </label>
            <label className="field">
              <span>단위</span>
              <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                {["kWh", "MWh", "Wh"].map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>구간 길이 (분)</span>
              <input
                type="number"
                min="1"
                max="1440"
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value))}
              />
            </label>
            <label className="field full">
              <span>측정시각의 의미</span>
              <select
                value={semantics}
                onChange={(e) => setSemantics(e.target.value)}
              >
                <option value="start">구간 시작시각</option>
                <option value="end">구간 종료시각</option>
              </select>
            </label>
          </div>
          <p className="hint">
            누적 계량값은 인접 측정치의 차이로 계산하며 리셋·이상값·중복·결측
            구간을 검사합니다.
          </p>
          <button
            className="btn primary block"
            disabled={
              !preview ||
              !available.length ||
              busy ||
              !mapping.timestamp ||
              !mapping.value ||
              !mapping.plant_id
            }
            onClick={() => void validate()}
          >
            {busy && <span className="spinner" />}
            월별 검증 실행
          </button>
        </section>
      </div>
      {preview && (
        <section className="card section-gap">
          <div className="card-heading">
            <h3>원본 미리보기</h3>
            <span className="muted">상위 {preview.rows.length}행</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {preview.headers.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i}>
                    {preview.headers.map((h) => (
                      <td key={h}>{String(r[h] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {result && (
        <>
          <section className="card section-gap">
            <div className="card-heading">
              <h3>
                검증 결과 ·{" "}
                {
                  {
                    generation: "실제 발전량",
                    sales: "판매전력량",
                    settlement: "정산전력량",
                  }[result.kind]
                }
              </h3>
              <span className="badge neutral">
                유효 행 {num(result.valid_rows)} / {num(result.row_count)}
              </span>
            </div>
            <div className="diagnostics">
              {Object.entries(result.diagnostics).map(([k, v]) => (
                <div key={k}>
                  <span>
                    {(
                      {
                        invalid_timestamp: "시각 오류",
                        invalid_value: "값 오류",
                        duplicate_timestamp: "중복 시각",
                        counter_reset: "계량기 리셋",
                        abnormal_energy: "이상 전력량",
                        missing_intervals: "결측 구간",
                        outside_model_period: "모델 기간 밖",
                      } as Record<string, string>
                    )[k] || k}
                  </span>
                  <strong>{typeof v === "number" ? num(v) : v}</strong>
                </div>
              ))}
            </div>
            {result.warnings.map((w, i) => (
              <div className="inline-warning" key={i}>
                {w}
              </div>
            ))}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>월</th>
                    <th>실적 (kWh)</th>
                    <th>모델 전체 월 (kWh)</th>
                    <th>동일 구간 모델 (kWh)</th>
                    <th>차이 (kWh)</th>
                    <th>상대오차</th>
                    <th>유효 자료</th>
                    <th>방향</th>
                  </tr>
                </thead>
                <tbody>
                  {result.monthly.map((m) => (
                    <tr key={m.period}>
                      <th>{m.period}</th>
                      <td>{num(m.actual_kwh, 1)}</td>
                      <td>{num(m.model_kwh, 1)}</td>
                      <td>{num(m.model_matched_kwh, 1)}</td>
                      <td>{num(m.difference_kwh, 1)}</td>
                      <td>
                        {m.relative_error_pct == null
                          ? "산정 불가"
                          : num(m.relative_error_pct, 1) + "%"}
                      </td>
                      <td>{num(m.valid_ratio * 100, 1)}%</td>
                      <td>{m.direction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
