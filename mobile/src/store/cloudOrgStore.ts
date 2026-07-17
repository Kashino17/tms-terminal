import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Folder organisation for the Season-2 cloud screen. The page (WebView) is
// the editor; this store is the persistent source of truth. Shape mirrors
// TMS_DATA.cloudOrg in the mockup exactly.
export interface CloudOrgFolder { id: string; name: string; color: string; order: number }
export interface CloudOrg {
  folders: CloudOrgFolder[];
  assignments: Record<string, string>;
  favorites: Record<string, true>;
  startFolderId: string | null;
  defaultFilters: { provider: 'all' | 'vercel' | 'render'; status: 'all' | 'active' | 'attention' };
}

export const EMPTY_CLOUD_ORG: CloudOrg = {
  folders: [],
  assignments: {},
  favorites: {},
  startFolderId: null,
  defaultFilters: { provider: 'all', status: 'all' },
};

interface CloudOrgState {
  org: CloudOrg;
  setOrg: (org: CloudOrg) => void;
}

export const useCloudOrgStore = create<CloudOrgState>()(
  persist(
    (set) => ({
      org: EMPTY_CLOUD_ORG,
      setOrg: (org) => set({ org }),
    }),
    { name: 'tms-cloud-org', storage: createJSONStorage(() => AsyncStorage) },
  ),
);
