import { Component } from "react";
import type { ReactNode } from "react";

type Props = { children: ReactNode; onRetry?: () => void };

/** Keep the rest of the workspace available if a map chunk or renderer fails. */
export default class MapBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="map-load-error" role="alert">
        <h3>지도를 불러오지 못했습니다</h3>
        <p>다른 화면과 입력 조건은 그대로 사용할 수 있습니다.</p>
        <div>
          <button className="btn primary" onClick={() => {
            this.props.onRetry?.();
            this.setState({ failed: false });
          }}>지도 다시 불러오기</button>
          <button className="btn" onClick={() => window.location.reload()}>화면 새로고침</button>
        </div>
      </div>
    );
  }
}
