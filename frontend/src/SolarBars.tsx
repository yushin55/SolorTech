import { num } from "./api";

export default function SolarBars({ values, title, estimated = false }: {
  values: (number | null)[]; title: string; estimated?: boolean;
}) {
  const maximum = Math.max(1, ...values.filter((value): value is number => value != null));
  return <figure className="solar-month-chart" aria-label={title}>
    <figcaption><strong>{title}</strong><span>MWh</span></figcaption>
    <ol>{Array.from({ length: 12 }, (_, month) => {
      const value = values[month];
      const season = [11, 0, 1].includes(month) ? "winter" : month < 5 ? "spring" : month < 8 ? "summer" : "autumn";
      return <li key={month}><span>{month + 1}월</span><div className="solar-month-track">
        {value != null ? <div className={`solar-month-bar ${season}`} style={{ width: `${Math.max(1, value / maximum * 100)}%` }} /> : null}
        <b>{value == null ? "자료 없음" : num(value / 1000, 1)}</b>
      </div></li>;
    })}</ol>
    <p>{estimated ? "등록 운영실적의 월별 원단위로 계산한 예측" : "등록된 월별 기록 합계 · 결측은 보간하지 않음"}</p>
  </figure>;
}
