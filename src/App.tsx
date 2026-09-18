import { useState } from 'react';
import VerifyPage from './components/VerifyPage';
import CalibrationWorkbench from './components/CalibrationWorkbench';
import './App.css';

type Workbench = 'verify' | 'calibration';

/**
 * 应用外壳：在“套准角标核验”页与“扫描照明校准”工作台之间切换。
 *
 * 两个页面始终保持挂载，非活动页仅以 hidden 隐藏（不卸载）：
 * 操作员从校准工作台返回核验页时，原上传图片、判定与已选证据仍保持可用。
 * 校准工作台只分析中性灰校准图，与角标核验结果完全隔离，互不改写。
 */
export default function App() {
  const [active, setActive] = useState<Workbench>('verify');

  return (
    <main className="app">
      <nav className="workbench-nav" aria-label="工作台切换">
        <button
          type="button"
          className={active === 'verify' ? 'active' : ''}
          aria-pressed={active === 'verify'}
          data-testid="nav-verify"
          onClick={() => setActive('verify')}
        >
          套准角标核验
        </button>
        <button
          type="button"
          className={active === 'verify' ? '' : 'active'}
          aria-pressed={active === 'calibration'}
          data-testid="nav-calibration"
          onClick={() => setActive('calibration')}
        >
          扫描照明校准
        </button>
      </nav>

      <div hidden={active !== 'verify'}>
        <VerifyPage />
      </div>
      <div hidden={active !== 'calibration'}>
        <CalibrationWorkbench />
      </div>
    </main>
  );
}
