import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useCloudAuthStore } from '../store/cloudAuthStore';
import { createRenderService } from '../services/render.service';
import { CloudSetup } from './CloudSetup';
import { CloudProjectList } from './CloudProjectList';
import { CloudProjectDetail } from './CloudProjectDetail';
import { startForegroundPolling, stopForegroundPolling } from '../services/cloudPolling.service';
import type { Project } from '../services/cloud.types';

export function RenderPanel() {
  const token = useCloudAuthStore((s) => s.tokens.render);
  const clearPlatform = useCloudAuthStore((s) => s.clearPlatform);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  const handleTokenExpired = useCallback(() => {
    clearPlatform('render');
  }, [clearPlatform]);

  const service = useMemo(
    () => (token ? createRenderService(token) : null),
    [token],
  );

  useEffect(() => {
    if (token) {
      startForegroundPolling(30_000);
    }
    return () => stopForegroundPolling();
  }, [token]);

  if (!token || !service) {
    return <CloudSetup platform="render" onConnected={() => {}} />;
  }

  if (selectedProject) {
    return (
      <CloudProjectDetail
        platform="render"
        service={service}
        project={selectedProject}
        onBack={() => setSelectedProject(null)}
        onTokenExpired={handleTokenExpired}
      />
    );
  }

  return (
    <CloudProjectList
      platform="render"
      service={service}
      onSelectProject={setSelectedProject}
      onTokenExpired={handleTokenExpired}
    />
  );
}
