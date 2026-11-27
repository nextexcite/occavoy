-- Recording a stopped agent job leaves the case awaiting operator intervention.
ALTER TABLE service_cases DROP CONSTRAINT service_cases_wait_reason_check,
 ADD CONSTRAINT service_cases_wait_reason_check CHECK (wait_reason IN ('agent_task','agent_intervention','supplier_quote','approval','supplier_confirmation','reconciliation'));
