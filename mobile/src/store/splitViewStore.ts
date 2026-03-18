import { create } from 'zustand';

export type SplitLayout = 'stack' | 'side' | 'tri';
export type TriMainPane = 'terminal' | 'browser1' | 'browser2';

interface SplitViewState {
  active: boolean;
  layout: SplitLayout;
  /** Which pane is the large left pane in tri-split */
  mainPane: TriMainPane;
  /** Browser port for stack/side and first browser in tri */
  browserPort: string;
  /** Second browser port (tri-split only) */
  browserPort2: string;

  activate: (port?: string) => void;
  deactivate: () => void;
  setLayout: (layout: SplitLayout) => void;
  setMainPane: (pane: TriMainPane) => void;
  cycleMain: () => void;
  setBrowserPort: (port: string) => void;
  setBrowserPort2: (port: string) => void;
}

const TRI_CYCLE: TriMainPane[] = ['terminal', 'browser1', 'browser2'];

export const useSplitViewStore = create<SplitViewState>((set, get) => ({
  active: false,
  layout: 'stack',
  mainPane: 'terminal',
  browserPort: '3000',
  browserPort2: '5173',

  activate(port) {
    set({ active: true, browserPort: port ?? get().browserPort });
  },
  deactivate() {
    set({ active: false });
  },
  setLayout(layout) {
    set({ layout });
  },
  setMainPane(pane) {
    set({ mainPane: pane });
  },
  cycleMain() {
    const cur = get().mainPane;
    const idx = TRI_CYCLE.indexOf(cur);
    set({ mainPane: TRI_CYCLE[(idx + 1) % TRI_CYCLE.length] });
  },
  setBrowserPort(port) {
    set({ browserPort: port });
  },
  setBrowserPort2(port) {
    set({ browserPort2: port });
  },
}));
