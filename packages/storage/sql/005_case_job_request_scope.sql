-- Pi submission IDs are local to a case's job, not shared across a tenant.
ALTER TABLE case_agent_jobs
  DROP CONSTRAINT case_agent_jobs_tenant_id_request_id_key,
  ADD CONSTRAINT case_agent_jobs_case_request_key UNIQUE (tenant_id, case_id, request_id);
