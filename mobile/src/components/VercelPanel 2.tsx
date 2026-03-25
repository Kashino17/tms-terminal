import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useCloudAuthStore } from '../store/cloudAuthStore';
import { createVercelService } from '../services/vercel.service';
import { CloudSetup } from './CloudSetup';
import { CloudProjectList } from './CloudProjectList';
import { CloudProjectDetail } from './CloudProjectDetail';
import { startForegroundPolling, stopForegroundPolling } from '../services/cloudPolling.service';
import type { Project } from '../services/cloud.types';

export function VercelPanel() {
  const token = useCloudAuthStore((s) => s.tokens.vercel);
  const clearPlatform = useCloudAuthStore((s) => s.clearPlatform);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  const handleTokenExpired = useCallback(() => {
    clearPlatform('vercel');
  }, [clearPlatform]);

  const service = useMemo(
    () => (token ? createVercelService(token) : null),
    [token],
  );

  useEffect(() => {
    if (token) {
      startForegroundPolling(30_000);
    }
    return () => stopForegroundPolling();
  }, [token]);

  if (!token || !service) {
    return <CloudSetup platform="vercel" onConnected={() => {}} />;
  }

  if (selectedProject) {
    return (
      <CloudProjectDetail
        platform="vercel"
        service={service}
        project={selectedProject}
        onBack={() => setSelectedProject(null)}
        onTokenExpired={handleTokenExpired}
      />
    );
  }

  return (
    <CloudProjectList
      platform="vercel"
      service={service}
      onSelectProject={setSelectedProject}
      onTokenExpired={handleTokenExpired}
    />
  );
}
