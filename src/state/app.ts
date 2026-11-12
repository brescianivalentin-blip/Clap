import { create } from 'zustand';

interface AppState {
  view: 'home' | 'editor';
  go(view: AppState['view']): void;
}

export const useApp = create<AppState>((set) => ({
  view: 'home',
  go(view) {
    set({ view });
  },
}));
