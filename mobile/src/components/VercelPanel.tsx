import React, { useMemo, useState } from 'react';
import { useCloudAuthStore } from '../store/cloudAuthStore';
import { createVercelService } from '../services/vercel.service';
import { CloudSetup } from './CloudSetup';
import { CloudProjectList } from './CloudProjectList';
import { CloudProjectDetail } from './CloudProjectDetail';
import type { Project } from '../services/cloud.types';

export function VercelPanel() {
  const token = useCloudAuthStore((s) => s.tokens.vercel);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  const service = useMemo(
    () => (token ? createVercelService(token) : null),
    [token],
  );

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
      />
    );
  }

  return (
    <CloudProjectList
      platform="vercel"
      service={service}
      onSelectProject={setSelectedProject}
    />
  );
}
