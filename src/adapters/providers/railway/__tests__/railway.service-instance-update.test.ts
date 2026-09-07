import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

describe('RailwayAdapter service instance updates', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it('passes serviceId and environmentId as top-level mutation variables', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      serviceInstanceUpdate: true,
    });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.updateServiceInstanceConfig({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      startCommand: 'npm start',
      healthcheckPath: '/health',
      cronSchedule: '0 * * * *',
    });

    expect(receipt.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toEqual({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      input: {
        startCommand: 'npm start',
        healthcheckPath: '/health',
        cronSchedule: '0 * * * *',
      },
    });
  });

  it('maps releaseCommand to Railway preDeployCommand as a single-element list', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      serviceInstanceUpdate: true,
    });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.updateServiceInstanceConfig({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      startCommand: 'npm start',
      releaseCommand: 'npx prisma migrate deploy',
    });

    expect(receipt.success).toBe(true);
    expect(request.mock.calls[0]?.[1]).toEqual({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      input: {
        startCommand: 'npm start',
        preDeployCommand: ['npx prisma migrate deploy'],
      },
    });
  });

  it('connects a service to a GitHub repo and branch via serviceConnect', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      serviceConnect: {
        id: 'svc-web',
      },
    });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.connectServiceToRepo({
      serviceId: 'svc-web',
      repo: 'davejohnson/billforge',
      branch: 'main',
    });

    expect(receipt.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toEqual({
      id: 'svc-web',
      input: {
        repo: 'davejohnson/billforge',
        branch: 'main',
      },
    });
  });

  it('disconnects a provider-native repo source via serviceDisconnect', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      serviceDisconnect: {
        id: 'svc-web',
      },
    });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.disconnectDeploySource({
      serviceId: 'svc-web',
    });

    expect(receipt).toMatchObject({
      success: true,
      data: { serviceId: 'svc-web' },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toContain('serviceDisconnect(id: $id)');
    expect(request.mock.calls[0]?.[1]).toEqual({
      id: 'svc-web',
    });
  });

  it('attaches a custom domain and returns Railway-required DNS records', async () => {
    const request = vi.fn()
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      })
      // getCustomDomainStatus before create
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: {
                  customDomains: [],
                },
              },
            }],
          },
        },
      })
      // customDomainCreate
      .mockResolvedValueOnce({
        customDomainCreate: {
          id: 'cd_123',
          domain: 'usebillforge.com',
        },
      })
      // getCustomDomainStatus after create
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: {
                  customDomains: [{
                    id: 'cd_123',
                    domain: 'usebillforge.com',
                    status: {
                      verified: false,
                      dnsRecords: [{
                        fqdn: 'usebillforge.com',
                        hostlabel: '@',
                        recordType: 'CNAME',
                        requiredValue: 'web-production.up.railway.app',
                        status: 'DNS_RECORD_STATUS_PENDING',
                        zone: 'usebillforge.com',
                      }],
                      verificationDnsHost: '_railway.usebillforge.com',
                      verificationToken: 'verify-token',
                    },
                  }],
                },
              },
            }],
          },
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.attachCustomDomain({
      projectId: 'rail-project-1',
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
    });

    expect(receipt.success).toBe(true);
    expect(request.mock.calls[2]?.[1]).toEqual({
      input: {
        projectId: 'rail-project-1',
        serviceId: 'svc-web',
        environmentId: 'env-prod',
        domain: 'usebillforge.com',
      },
    });
    expect(receipt.data).toMatchObject({
      domain: 'usebillforge.com',
      customDomainId: 'cd_123',
      created: true,
      providerVerified: false,
      dnsRecords: [
        {
          name: 'usebillforge.com',
          type: 'CNAME',
          value: 'web-production.up.railway.app',
        },
        {
          name: '_railway.usebillforge.com',
          type: 'TXT',
          value: 'verify-token',
        },
      ],
    });
  });

  it('refreshes an existing unverified custom domain without deleting it', async () => {
    const pendingDomain = {
      id: 'cd_pending',
      domain: 'usebillforge.com',
      status: {
        verified: false,
        certificateStatus: 'CERTIFICATE_STATUS_TYPE_ISSUING',
        dnsRecords: [{
          fqdn: 'usebillforge.com',
          hostlabel: '@',
          recordType: 'CNAME',
          requiredValue: 'web-production.up.railway.app',
          currentValue: 'web-production.up.railway.app',
          status: 'DNS_RECORD_STATUS_PROPAGATED',
          zone: 'usebillforge.com',
        }],
        verificationDnsHost: '_railway-verify.usebillforge.com',
        verificationToken: 'railway-verify=verify-token',
      },
    };
    const domainObservation = {
      service: {
        serviceInstances: {
          edges: [{
            node: {
              environmentId: 'env-prod',
              domains: { customDomains: [pendingDomain] },
            },
          }],
        },
      },
    };
    const request = vi.fn()
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      })
      // getCustomDomainStatus before refresh
      .mockResolvedValueOnce(domainObservation)
      // customDomainUpdate
      .mockResolvedValueOnce({ customDomainUpdate: true })
      // getCustomDomainStatus after refresh
      .mockResolvedValueOnce(domainObservation);

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.attachCustomDomain({
      projectId: 'rail-project-1',
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
    });

    expect(receipt).toMatchObject({
      success: true,
      message: expect.stringContaining('refreshed pending verification'),
      data: {
        domain: 'usebillforge.com',
        customDomainId: 'cd_pending',
        created: false,
        refreshed: true,
        providerVerified: false,
        certificateStatus: 'CERTIFICATE_STATUS_TYPE_ISSUING',
      },
    });
    expect(String(request.mock.calls[2]?.[0])).toContain('customDomainUpdate');
    expect(request.mock.calls[2]?.[1]).toEqual({
      id: 'cd_pending',
      environmentId: 'env-prod',
    });
    expect(request.mock.calls.some((call) => String(call[0]).includes('customDomainDelete'))).toBe(false);
  });

  it('does not refresh an existing verified custom domain', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: {
                  customDomains: [{
                    id: 'cd_verified',
                    domain: 'usebillforge.com',
                    status: { verified: true, certificateStatus: 'CERTIFICATE_STATUS_TYPE_ISSUED' },
                  }],
                },
              },
            }],
          },
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    const receipt = await adapter.attachCustomDomain({
      projectId: 'rail-project-1',
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
    });

    expect(receipt).toMatchObject({
      success: true,
      data: { created: false, providerVerified: true },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('detaches the exact Railway custom domain and verifies terminal absence', async () => {
    const existingDomain = { id: 'cd_exact', domain: 'usebillforge.com', status: { verified: true } };
    const request = vi.fn()
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod', domains: { customDomains: [existingDomain] } } }],
          },
        },
      })
      .mockResolvedValueOnce({ customDomainDelete: true })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod', domains: { customDomains: [] } } }],
          },
        },
      });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.detachCustomDomain({
      projectId: 'rail-project-1',
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
      customDomainId: 'cd_exact',
    });

    expect(receipt).toMatchObject({
      success: true,
      data: { customDomainId: 'cd_exact', deleted: true },
    });
    expect(String(request.mock.calls[1]?.[0])).toContain('customDomainDelete');
    expect(request.mock.calls[1]?.[1]).toEqual({ id: 'cd_exact' });
  });

  it('blocks custom-domain deletion when the reviewed Railway id changed', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      service: {
        serviceInstances: {
          edges: [{
            node: {
              environmentId: 'env-prod',
              domains: { customDomains: [{ id: 'cd_other', domain: 'usebillforge.com' }] },
            },
          }],
        },
      },
    });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.detachCustomDomain({
      projectId: 'rail-project-1',
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
      customDomainId: 'cd_reviewed',
    });

    expect(receipt).toMatchObject({ success: false, message: expect.stringContaining('identity changed') });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('treats an already-absent Railway custom domain as a successful retry', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      service: {
        serviceInstances: {
          edges: [{ node: { environmentId: 'env-prod', domains: { customDomains: [] } } }],
        },
      },
    });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.detachCustomDomain({
      projectId: 'rail-project-1',
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
      customDomainId: 'cd_deleted',
    });

    expect(receipt).toMatchObject({ success: true, data: { alreadyAbsent: true } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('deletes and recreates only the selected Railway custom domain', async () => {
    const existingDomain = {
      id: 'cd_old',
      domain: 'usebillforge.com',
      status: { verified: false },
    };
    const request = vi.fn()
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: { serviceInstances: { edges: [{ node: { environmentId: 'env-prod' } }] } },
      })
      // getCustomDomainStatus before delete
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: { customDomains: [existingDomain] },
              },
            }],
          },
        },
      })
      // customDomainDelete
      .mockResolvedValueOnce({ customDomainDelete: true })
      // getCustomDomainStatus verifies terminal absence before replacement
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: { customDomains: [] },
              },
            }],
          },
        },
      })
      // customDomainCreate
      .mockResolvedValueOnce({
        customDomainCreate: { id: 'cd_new', domain: 'usebillforge.com' },
      })
      // getCustomDomainStatus after create
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: {
                  customDomains: [{
                    id: 'cd_new',
                    domain: 'usebillforge.com',
                    status: {
                      verified: false,
                      certificateStatus: 'CERTIFICATE_STATUS_TYPE_ISSUING',
                      dnsRecords: [{
                        fqdn: 'usebillforge.com',
                        recordType: 'CNAME',
                        requiredValue: 'new-target.up.railway.app',
                        status: 'DNS_RECORD_STATUS_PENDING',
                      }],
                      verificationDnsHost: '_railway-verify.usebillforge.com',
                      verificationToken: 'railway-verify=new-token',
                    },
                  }],
                },
              },
            }],
          },
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    const receipt = await adapter.recreateCustomDomain({
      projectId: 'rail-project-1',
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
    });

    expect(receipt).toMatchObject({
      success: true,
      data: {
        domain: 'usebillforge.com',
        previousCustomDomainId: 'cd_old',
        customDomainId: 'cd_new',
        recreated: true,
        providerVerified: false,
        dnsRecords: [
          expect.objectContaining({ type: 'CNAME', value: 'new-target.up.railway.app' }),
          expect.objectContaining({ type: 'TXT', value: 'railway-verify=new-token' }),
        ],
      },
    });
    expect(String(request.mock.calls[2]?.[0])).toContain('customDomainDelete');
    expect(request.mock.calls[2]?.[1]).toEqual({ id: 'cd_old' });
    expect(String(request.mock.calls[4]?.[0])).toContain('customDomainCreate');
    expect(request.mock.calls[4]?.[1]).toEqual({
      input: {
        projectId: 'rail-project-1',
        serviceId: 'svc-web',
        environmentId: 'env-prod',
        domain: 'usebillforge.com',
      },
    });
  });

  it('blocks custom-domain mutation when Railway returns duplicate identities', async () => {
    const duplicate = (id: string) => ({ id, domain: 'usebillforge.com', status: { verified: false } });
    const request = vi.fn()
      .mockResolvedValueOnce({
        service: { serviceInstances: { edges: [{ node: { environmentId: 'env-prod' } }] } },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: { customDomains: [duplicate('cd-1'), duplicate('cd-2')] },
              },
            }],
          },
        },
      });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.recreateCustomDomain({
      projectId: 'rail-project-1',
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
    });

    expect(receipt).toMatchObject({
      success: false,
      data: { phase: 'observeCustomDomain' },
      error: expect.stringContaining('Multiple Railway custom-domain attachments match'),
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not recreate until Railway confirms the old custom domain is absent', async () => {
    const existingDomain = { id: 'cd-old', domain: 'usebillforge.com', status: { verified: false } };
    const request = vi.fn()
      .mockResolvedValueOnce({
        service: { serviceInstances: { edges: [{ node: { environmentId: 'env-prod' } }] } },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod', domains: { customDomains: [existingDomain] } } }],
          },
        },
      })
      .mockResolvedValueOnce({ customDomainDelete: true })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod', domains: { customDomains: [existingDomain] } } }],
          },
        },
      });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.recreateCustomDomain({
      projectId: 'rail-project-1',
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
    });

    expect(receipt).toMatchObject({
      success: false,
      data: { phase: 'customDomainDeleteVerification', customDomainId: 'cd-old' },
      error: expect.stringContaining('still exists after deletion'),
    });
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.some((call) => String(call[0]).includes('customDomainCreate'))).toBe(false);
  });

  it('does not call Railway customDomainCreate without a projectId binding', async () => {
    const request = vi.fn();
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.attachCustomDomain({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
    });

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('requires the Railway projectId');
    expect(request).not.toHaveBeenCalled();
  });

  it('does not create a service when project-service inventory is unknown', async () => {
    const request = vi.fn(async (query: unknown) => {
      const text = String(query);
      if (text.includes('GetEnvironments')) {
        return {
          project: {
            environments: {
              edges: [{ node: { id: 'env-prod', name: 'production' } }],
            },
          },
        };
      }
      if (text.includes('GetProjectServices')) {
        throw new Error('Railway service inventory timed out');
      }
      throw new Error(`Unexpected mutation after failed inventory: ${text}`);
    });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const environment: Environment = {
      id: 'env-local',
      projectId: 'proj-local',
      name: 'production',
      platformBindings: { projectId: 'rail-project-1', environmentId: 'env-prod', services: {} },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const service: Service = {
      id: 'svc-local',
      projectId: 'proj-local',
      name: 'web',
      buildConfig: { builder: 'nixpacks', public: true },
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, {});

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('inventory timed out');
    expect(request.mock.calls.some(([query]) => String(query).includes('ServiceCreate'))).toBe(false);
  });

  it('does not create a service when project-environment inventory is unknown', async () => {
    const request = vi.fn(async (query: unknown) => {
      const text = String(query);
      if (text.includes('GetEnvironments')) {
        throw new Error('Railway environment inventory timed out');
      }
      throw new Error(`Unexpected mutation after failed inventory: ${text}`);
    });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const environment: Environment = {
      id: 'env-local',
      projectId: 'proj-local',
      name: 'production',
      platformBindings: { projectId: 'rail-project-1', environmentId: 'env-prod', services: {} },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const service: Service = {
      id: 'svc-local',
      projectId: 'proj-local',
      name: 'web',
      buildConfig: { builder: 'nixpacks', public: true },
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, {});

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('environment inventory timed out');
    expect(request.mock.calls.some(([query]) => String(query).includes('ServiceCreate'))).toBe(false);
  });

  it('creates a Railway service domain for public services and returns the url', async () => {
    const request = vi.fn()
      // resolveRailwayEnvironmentId -> listProjectEnvironmentIds
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-prod', name: 'production' } }],
          },
        },
      })
      // resolveServiceIdForProject -> listProjectServices
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-web', name: 'web' } }],
          },
        },
      })
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      })
      // redeploy
      .mockResolvedValueOnce({
        serviceInstanceRedeploy: true,
      })
      // ensureServiceDomain: query existing domains (none)
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: { serviceDomains: [] },
              },
            }],
          },
        },
      })
      // ensureServiceDomain: serviceDomainCreate
      .mockResolvedValueOnce({
        serviceDomainCreate: { domain: 'web-production.up.railway.app' },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const environment: Environment = {
      id: 'env-local',
      projectId: 'proj-local',
      name: 'production',
      platformBindings: {
        projectId: 'rail-project-1',
        environmentId: 'env-prod',
        services: {},
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const service: Service = {
      id: 'svc-local',
      projectId: 'proj-local',
      name: 'web',
      buildConfig: {
        builder: 'nixpacks',
        public: true,
      },
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, {});

    expect(result.receipt.success).toBe(true);
    expect(result.url).toBe('https://web-production.up.railway.app');
    // serviceDomainCreate received the right input
    expect(request.mock.calls[5]?.[1]).toEqual({
      input: { serviceId: 'svc-web', environmentId: 'env-prod' },
    });
    expect(request.mock.calls.every(([query]) => !String(query).includes('GetProjectPlugins'))).toBe(true);
  });

  it('does not create a service domain for non-public services', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-prod', name: 'production' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-worker', name: 'worker' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        serviceInstanceRedeploy: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const environment: Environment = {
      id: 'env-local',
      projectId: 'proj-local',
      name: 'production',
      platformBindings: {
        projectId: 'rail-project-1',
        environmentId: 'env-prod',
        services: {},
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const service: Service = {
      id: 'svc-local',
      projectId: 'proj-local',
      name: 'worker',
      buildConfig: {
        builder: 'nixpacks',
      },
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, {});

    expect(result.receipt.success).toBe(true);
    expect(result.url).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('does not replace a bound service when it only exists in another environment', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-staging', name: 'staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-web', name: 'web' } }],
          },
        },
      })
      // resolveServiceIdForEnvironment: bound/name-matched service only exists in production.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      })
      // ensureServiceInstanceForEnvironment confirms the bound service is still production-only.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const environment: Environment = {
      id: 'env-local',
      projectId: 'proj-local',
      name: 'staging',
      platformBindings: {
        projectId: 'rail-project-1',
        environmentId: 'env-staging',
        services: { web: { serviceId: 'svc-web' } },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const service: Service = {
      id: 'svc-local',
      projectId: 'proj-local',
      name: 'web',
      buildConfig: {
        builder: 'nixpacks',
      },
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, {});

    expect(result.receipt.success).toBe(false);
    expect(result.externalId).toBe('svc-web');
    expect(result.receipt.data).toMatchObject({
      phase: 'ensureServiceInstance',
      serviceId: 'svc-web',
      environmentId: 'env-staging',
    });
    expect(request.mock.calls.some(([query]) => String(query).includes('serviceCreate'))).toBe(false);
  });

  it('applies runtime config before redeploying a service', async () => {
    const request = vi.fn()
      // resolveRailwayEnvironmentId -> listProjectEnvironmentIds
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-prod', name: 'production' } }],
          },
        },
      })
      // resolveServiceIdForProject -> listProjectServices
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [],
          },
        },
      })
      // serviceCreate
      .mockResolvedValueOnce({
        serviceCreate: {
          id: 'svc-web',
          name: 'web',
        },
      })
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      })
      // redeploy
      .mockResolvedValueOnce({
        serviceInstanceRedeploy: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const updateServiceInstanceConfig = vi
      .spyOn(adapter, 'updateServiceInstanceConfig')
      .mockResolvedValue({ success: true, message: 'configured' });
    const setEnvVars = vi
      .spyOn(adapter, 'setEnvVars')
      .mockResolvedValue({ success: true, message: 'vars synced' });

    const environment: Environment = {
      id: 'env-local',
      projectId: 'proj-local',
      name: 'production',
      platformBindings: {
        projectId: 'rail-project-1',
        environmentId: 'env-prod',
        services: {},
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const service: Service = {
      id: 'svc-local',
      projectId: 'proj-local',
      name: 'web',
      buildConfig: {
        builder: 'nixpacks',
        startCommand: 'npm start',
        healthCheckPath: '/health',
      },
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, { DATABASE_URL: 'postgres://db' });

    expect(result.receipt.success).toBe(true);
    expect(updateServiceInstanceConfig).toHaveBeenCalledWith({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      startCommand: 'npm start',
      healthcheckPath: '/health',
      cronSchedule: undefined,
    });
    expect(setEnvVars).toHaveBeenCalledWith(
      expect.objectContaining({
        platformBindings: expect.objectContaining({
          services: {
            web: { serviceId: 'svc-web' },
          },
        }),
      }),
      service,
      { DATABASE_URL: 'postgres://db' }
    );
  });

  it('configures a CI-managed service without redeploying its previous image', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-prod', name: 'production' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-web', name: 'web' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const environment: Environment = {
      id: 'env-local',
      projectId: 'proj-local',
      name: 'production',
      platformBindings: {
        projectId: 'rail-project-1',
        environmentId: 'env-prod',
        services: { web: { serviceId: 'svc-web' } },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const service: Service = {
      id: 'svc-local',
      projectId: 'proj-local',
      name: 'web',
      buildConfig: { builder: 'nixpacks' },
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.deploy(
      service,
      environment,
      {},
      { deferDeployment: true }
    );

    expect(result.status).toBe('configured');
    expect(result.receipt).toMatchObject({
      success: true,
      data: { deploymentDeferred: true },
    });
    expect(request.mock.calls.some(([query]) => String(query).includes('serviceInstanceRedeploy'))).toBe(false);
  });

  it('retains a wrong-name create id only as failed recovery identity and stops follow-up mutations', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: { edges: [{ node: { id: 'env-staging', name: 'staging' } }] },
        },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({ serviceCreate: { id: 'svc-wrong', name: 'not-web-staging' } });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    const environment: Environment = {
      id: 'env-local', projectId: 'project-local', name: 'staging',
      platformBindings: { projectId: 'rail-project', environmentId: 'env-staging', services: {} },
      createdAt: new Date(), updatedAt: new Date(),
    };
    const service: Service = {
      id: 'service-local', projectId: 'project-local', name: 'web',
      buildConfig: { builder: 'nixpacks', public: true, startCommand: 'npm start' },
      envVarSpec: {}, createdAt: new Date(), updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, { SECRET: 'not-output' });

    expect(result).toMatchObject({
      externalId: 'svc-wrong',
      status: 'failed',
      receipt: {
        success: false,
        data: {
          mutationAttempted: true,
          serviceCreateRecovery: {
            provider: 'railway',
            operation: 'create',
            resourceName: 'web-staging',
            providerScope: { projectId: 'rail-project', environmentId: 'env-staging' },
            state: 'mismatched',
            serviceId: 'svc-wrong',
            returnedName: 'not-web-staging',
          },
        },
      },
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.some(([query]) => /serviceInstance(?:Update|Redeploy)|variableCollectionUpsert|serviceDomainCreate/.test(String(query)))).toBe(false);
  });

  it('recovers an exact-name and exact-environment service after a malformed create id without mutating it', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: { edges: [{ node: { id: 'env-staging', name: 'staging' } }] },
        },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({ serviceCreate: { id: '', name: 'web-staging' } })
      .mockResolvedValueOnce({
        project: { services: { edges: [{ node: { id: 'svc-recovered', name: 'web-staging' } }] } },
      })
      .mockResolvedValueOnce({
        service: {
          id: 'svc-recovered',
          serviceInstances: { edges: [{ node: { environmentId: 'env-staging' } }] },
        },
      });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    const environment: Environment = {
      id: 'env-local', projectId: 'project-local', name: 'staging',
      platformBindings: { projectId: 'rail-project', environmentId: 'env-staging', services: {} },
      createdAt: new Date(), updatedAt: new Date(),
    };
    const service: Service = {
      id: 'service-local', projectId: 'project-local', name: 'web',
      buildConfig: { builder: 'nixpacks', public: true, startCommand: 'npm start' },
      envVarSpec: {}, createdAt: new Date(), updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, { SECRET: 'not-output' });

    expect(result).toMatchObject({
      externalId: 'svc-recovered',
      status: 'failed',
      receipt: {
        success: false,
        data: {
          serviceCreateRecovery: {
            state: 'identified',
            serviceId: 'svc-recovered',
            returnedName: 'web-staging',
          },
        },
      },
    });
    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls.some(([query]) => /serviceInstance(?:Update|Redeploy)|variableCollectionUpsert|serviceDomainCreate/.test(String(query)))).toBe(false);
  });

  it('treats HTTP 408 service-create responses as unresolved and never retries the mutation', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const timeout = Object.assign(new Error('request timed out'), { response: { status: 408 } });
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: { edges: [{ node: { id: 'env-staging', name: 'staging' } }] },
        },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ project: { services: { edges: [] } } });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    const environment: Environment = {
      id: 'env-local', projectId: 'project-local', name: 'staging',
      platformBindings: { projectId: 'rail-project', environmentId: 'env-staging', services: {} },
      createdAt: new Date(), updatedAt: new Date(),
    };
    const service: Service = {
      id: 'service-local', projectId: 'project-local', name: 'web',
      buildConfig: { builder: 'nixpacks' }, envVarSpec: {},
      createdAt: new Date(), updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, {});

    expect(result.externalId).toBeUndefined();
    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        mutationAttempted: true,
        serviceCreateRecovery: {
          state: 'unresolved',
          resourceName: 'web-staging',
          providerScope: { projectId: 'rail-project', environmentId: 'env-staging' },
        },
      },
    });
    expect(request.mock.calls.filter(([query]) => String(query).includes('serviceCreate'))).toHaveLength(1);
  });

  it('blocks a second create when exact persisted service-create recovery state exists', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      project: {
        environments: { edges: [{ node: { id: 'env-staging', name: 'staging' } }] },
      },
    });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    const environment: Environment = {
      id: 'env-local', projectId: 'project-local', name: 'staging',
      platformBindings: {
        projectId: 'rail-project',
        environmentId: 'env-staging',
        services: {},
        serviceCreateRecovery: {
          web: {
            provider: 'railway',
            operation: 'create',
            resourceName: 'web-staging',
            providerScope: { projectId: 'rail-project', environmentId: 'env-staging' },
            state: 'unresolved',
          },
        },
      },
      createdAt: new Date(), updatedAt: new Date(),
    };
    const service: Service = {
      id: 'service-local', projectId: 'project-local', name: 'web',
      buildConfig: { builder: 'nixpacks' }, envVarSpec: {},
      createdAt: new Date(), updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, {});

    expect(result).toMatchObject({
      status: 'failed',
      receipt: { success: false, data: { mutationAttempted: false } },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(([query]) => String(query).includes('serviceCreate'))).toBe(false);
  });
});
