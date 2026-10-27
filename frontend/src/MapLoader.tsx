import { lazy, Suspense, useState } from "react";
import type { ComponentProps } from "react";
import type MapView from "./MapView";
import MapBoundary from "./MapBoundary";

function createMap(retry = false) {
  return lazy(() => {
    // A rejected lazy component is cached by React. A new component and dev URL
    // make retry fetch the transformed module with the current dependency hash.
    if (retry && import.meta.env.DEV) {
      return import(/* @vite-ignore */ `/src/MapView.tsx?map_retry=${Date.now()}`);
    }
    return import("./MapView");
  });
}

export default function MapLoader(props: ComponentProps<typeof MapView>) {
  const [Map, setMap] = useState(() => createMap());
  return (
    <MapBoundary onRetry={() => setMap(() => createMap(true))}>
      <Suspense fallback={<div className="map-view empty">지도를 불러오는 중…</div>}>
        <Map {...props} />
      </Suspense>
    </MapBoundary>
  );
}
