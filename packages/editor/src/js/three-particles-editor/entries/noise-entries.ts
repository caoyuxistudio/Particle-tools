type NoiseEntriesParams = {
  parentFolder: any;
  particleSystemConfig: any;
  recreateParticleSystem: () => void;
};

export const createNoiseEntries = ({
  parentFolder,
  particleSystemConfig,
  recreateParticleSystem,
}: NoiseEntriesParams): Record<string, unknown> => {
  const folder = parentFolder.addFolder('Noise');
  folder.close();

  const noise = particleSystemConfig.noise;
  if (!noise.type) noise.type = 'SIMPLEX';
  if (!noise.drift) noise.drift = { x: 0.15, y: 0.11, z: 0.13 };
  (['x', 'y', 'z'] as const).forEach((axis) => {
    if (noise.drift[axis] === undefined) noise.drift[axis] = { x: 0.15, y: 0.11, z: 0.13 }[axis];
  });

  folder.add(particleSystemConfig.noise, 'isActive').onChange(recreateParticleSystem).listen();

  folder
    .add(particleSystemConfig.noise, 'useRandomOffset')
    .onChange(recreateParticleSystem)
    .listen();

  folder.add(particleSystemConfig.noise, 'curl').onChange(recreateParticleSystem).listen();

  // The noise the curl field is built from. Baked into the GPU kernel, so a
  // change here rebuilds the system (the glue's structural check catches it).
  folder
    .add(particleSystemConfig.noise, 'type', { simplex: 'SIMPLEX', perlin: 'PERLIN' })
    .name('type (curl)')
    .onChange(recreateParticleSystem)
    .listen();

  // How fast the curl field itself scrolls along each world axis, in field
  // units per second. All three at 0 is a still field the particles flow
  // through; (0.15, 0.11, 0.13) is the motion it has always had.
  const driftFolder = folder.addFolder('drift (field motion per axis)');
  (['x', 'y', 'z'] as const).forEach((axis) => {
    driftFolder
      .add(particleSystemConfig.noise.drift, axis, -3, 3, 0.01)
      .onChange(recreateParticleSystem)
      .listen();
  });

  folder
    .add(particleSystemConfig.noise, 'strength', 0.0, 2.0, 0.01)
    .onChange(recreateParticleSystem)
    .listen();

  folder
    .add(particleSystemConfig.noise, 'frequency', 0.0001, 3.0, 0.001)
    .onChange(recreateParticleSystem)
    .listen();

  folder
    .add(particleSystemConfig.noise, 'octaves', 1, 4, 1)
    .onChange(recreateParticleSystem)
    .listen();

  folder
    .add(particleSystemConfig.noise, 'positionAmount', -5.0, 5.0, 0.001)
    .onChange(recreateParticleSystem)
    .listen();

  const influenceFolder = folder.addFolder('influence');
  influenceFolder
    .add(particleSystemConfig.noise.influence, 'x', 0.0, 1.0, 0.01)
    .onChange(recreateParticleSystem)
    .listen();
  influenceFolder
    .add(particleSystemConfig.noise.influence, 'y', 0.0, 1.0, 0.01)
    .onChange(recreateParticleSystem)
    .listen();
  influenceFolder
    .add(particleSystemConfig.noise.influence, 'z', 0.0, 1.0, 0.01)
    .onChange(recreateParticleSystem)
    .listen();

  folder
    .add(particleSystemConfig.noise, 'rotationAmount', -5.0, 5.0, 0.001)
    .onChange(recreateParticleSystem)
    .listen();

  folder
    .add(particleSystemConfig.noise, 'sizeAmount', -5.0, 5.0, 0.001)
    .onChange(recreateParticleSystem)
    .listen();

  return {};
};
