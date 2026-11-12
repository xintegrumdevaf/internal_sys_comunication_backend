-- Enruta a General cualquier caso o escalación histórica que haya quedado
-- sin departamento (department_id NULL) o marcada como UNCLASSIFIED, evitando
-- que permanezca estancada sin asignación en pool de triage.

DO $$
DECLARE
  v_general_id UUID;
BEGIN
  SELECT id INTO v_general_id
  FROM department
  WHERE active = true
    AND (
      LOWER(slug) IN ('general', 'atencion', 'atencion-al-cliente', 'recepcion')
      OR LOWER(name) = 'general'
    )
  ORDER BY
    CASE LOWER(slug)
      WHEN 'general' THEN 1
      WHEN 'atencion' THEN 2
      WHEN 'atencion-al-cliente' THEN 3
      WHEN 'recepcion' THEN 4
      ELSE 5
    END
  LIMIT 1;

  IF v_general_id IS NOT NULL THEN
    UPDATE "case"
    SET department_id = v_general_id,
        workflow_type = CASE WHEN workflow_type = 'UNCLASSIFIED' THEN 'GENERAL_INQUIRY' ELSE workflow_type END,
        context = CASE
          WHEN context->>'workflowType' = 'UNCLASSIFIED'
            THEN jsonb_set(context, '{workflowType}', '"GENERAL_INQUIRY"'::jsonb)
          ELSE context
        END,
        updated_at = now()
    WHERE department_id IS NULL
       OR workflow_type = 'UNCLASSIFIED';

    UPDATE workflow_instance wi
    SET workflow_type = 'GENERAL_INQUIRY',
        updated_at = now()
    FROM "case" c
    WHERE wi.case_id = c.id
      AND wi.workflow_type = 'UNCLASSIFIED';

    UPDATE escalation
    SET department_id = v_general_id
    WHERE department_id IS NULL;
  END IF;
END $$;
