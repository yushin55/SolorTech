import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export type SearchLocation = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  bbox: [number, number, number, number];
  source: "local" | "nominatim";
  kind: "region" | "place";
};
type SearchResponse = {
  results: SearchLocation[];
  provider: string;
  warning: string | null;
  attribution: string;
};
export default function MapSearch({
  onSelect,
}: {
  onSelect: (location: SearchLocation) => void;
}) {
  const [query, setQuery] = useState(""),
    [response, setResponse] = useState<SearchResponse | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [open, setOpen] = useState(false);
  const controller = useRef<AbortController | null>(null),
    root = useRef<HTMLDivElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  async function search() {
    const value = query.trim();
    if (value.length < 2) {
      setError("지역명 또는 위도, 경도를 2자 이상 입력하세요.");
      return;
    }
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError("");
    setOpen(true);
    setResponse(null);
    try {
      const data = await api<SearchResponse>(
        `/geocoding/search?q=${encodeURIComponent(value)}`,
        { signal: request.signal },
      );
      if (!request.signal.aborted) setResponse(data);
    } catch (cause) {
      if (!request.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "검색에 실패했습니다. 다시 시도하세요.",
        );
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }
  return (
    <div className="map-search" ref={root}>
      <form
        className="map-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="지도 지역 검색"
          placeholder="지역 이름 또는 위도, 경도 (예: 충주시)"
          value={query}
          maxLength={120}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
          onFocus={() => {
            if (response) setOpen(true);
          }}
        />
        {query && (
          <button
            type="button"
            className="map-search-clear"
            aria-label="검색어 지우기"
            onClick={() => {
              controller.current?.abort();
              setQuery("");
              setResponse(null);
              setError("");
              setOpen(false);
              setLoading(false);
            }}
          >
            ×
          </button>
        )}
        <button className="map-search-submit" type="submit" disabled={loading}>
          검색
        </button>
      </form>
      {error && (
        <div className="map-search-error" role="alert">
          {error}
        </div>
      )}
      {open && (loading || response) && (
        <div className="map-search-results">
          {loading ? (
            <p className="search-feedback" role="status">
              지역을 찾고 있습니다…
            </p>
          ) : (
            <>
              {response?.results.length ? (
                <ul aria-label="지역 검색 결과">
                  {response.results.map((location) => (
                    <li key={location.id}>
                      <button
                        onClick={() => {
                          onSelect(location);
                          setQuery(location.label);
                          setOpen(false);
                        }}
                      >
                        <span>
                          {location.label}
                          <small>
                            {location.kind === "region"
                              ? "지역"
                              : "장소"}
                          </small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="search-feedback">
                  검색 결과가 없습니다. 시·군·구 이름이나 위도, 경도로
                  다시 검색하세요.
                </p>
              )}
              {response?.warning && (
                <p className="search-provider-note">{response.warning}</p>
              )}
              {response?.attribution && (
                <p className="search-attribution">{response.attribution}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
