import React, { useMemo, useState } from 'react';
import { useCloudAuthStore } from '../store/cloudAuthStore';
import { createRenderService } from '../services/render.service';
import { CloudSetup } from './CloudSetup';
import { CloudProjectList } from './CloudProjectList';
import { CloudProjectDetail } from './CloudProjectDetail';
import type { Project } from '../services/cloud.types';

export function RenderPanel() {
  const token = useCloudAuthStore((s) => s.tokens.render);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  const service = useMemo(
    () => (token ? createRenderService(token) : null),
    [token],
  );

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
      />
    );
  }

  return (
    <CloudProjectList
      platform="render"
      service={service}
      onSelectProject={setSelectedProject}
    />
  );
}
