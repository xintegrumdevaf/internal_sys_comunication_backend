import type { Pool } from "pg";
import type { PromptTemplate } from "../../domain/entities/prompt-template.entity";
import type { PromptVersion } from "../../domain/entities/prompt-version.entity";
import type {
  CreatePromptVersionInput,
  PromptTemplateRepositoryPort,
  PromptTemplateWithActiveVersion,
} from "../../application/ports/prompt-template.repository.port";

export class PromptTemplateRepositoryPg implements PromptTemplateRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async listTemplates(): Promise<PromptTemplateWithActiveVersion[]> {
    const query = `
      SELECT 
        t.id,
        t.slug,
        t.name,
        t.description,
        t.department_id,
        t.allowed_variables,
        t.variable_definitions,
        t.active_version_id,
        t.created_at,
        t.updated_at,
        v.id AS v_id,
        v.version_number AS v_version_number,
        v.system_prompt AS v_system_prompt,
        v.user_template AS v_user_template,
        v.model_config AS v_model_config,
        v.status AS v_status,
        v.change_notes AS v_change_notes,
        v.created_by AS v_created_by,
        v.published_at AS v_published_at,
        v.created_at AS v_created_at,
        (SELECT COUNT(*)::int FROM ai_prompt_versions WHERE template_id = t.id) AS versions_count
      FROM ai_prompt_templates t
      LEFT JOIN ai_prompt_versions v ON t.active_version_id = v.id
      ORDER BY t.name ASC
    `;

    const { rows } = await this.pool.query(query);
    return rows.map((r) => {
      const activeVersion: PromptVersion | null = r.v_id
        ? {
            id: r.v_id,
            templateId: r.id,
            versionNumber: r.v_version_number,
            systemPrompt: r.v_system_prompt,
            userTemplate: r.v_user_template,
            modelConfig: r.v_model_config || {},
            status: r.v_status,
            changeNotes: r.v_change_notes,
            createdBy: r.v_created_by,
            publishedAt: r.v_published_at ? new Date(r.v_published_at) : null,
            createdAt: new Date(r.v_created_at),
          }
        : null;

      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        departmentId: r.department_id,
        allowedVariables: Array.isArray(r.allowed_variables) ? r.allowed_variables : [],
        variableDefinitions: Array.isArray(r.variable_definitions) ? r.variable_definitions : [],
        activeVersionId: r.active_version_id,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at),
        activeVersion,
        versionsCount: r.versions_count ?? 0,
      };
    });
  }

  async findBySlug(slug: string): Promise<PromptTemplate | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ai_prompt_templates WHERE slug = $1 LIMIT 1`,
      [slug],
    );
    if (rows.length === 0) return null;
    return this.mapTemplateRow(rows[0]);
  }

  async findById(id: string): Promise<PromptTemplate | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ai_prompt_templates WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (rows.length === 0) return null;
    return this.mapTemplateRow(rows[0]);
  }

  async getActiveVersion(templateId: string): Promise<PromptVersion | null> {
    const { rows } = await this.pool.query(
      `SELECT v.* 
       FROM ai_prompt_templates t
       JOIN ai_prompt_versions v ON t.active_version_id = v.id
       WHERE t.id = $1 LIMIT 1`,
      [templateId],
    );
    if (rows.length === 0) return null;
    return this.mapVersionRow(rows[0]);
  }

  async getActiveVersionBySlug(slug: string): Promise<PromptVersion | null> {
    const { rows } = await this.pool.query(
      `SELECT v.* 
       FROM ai_prompt_templates t
       JOIN ai_prompt_versions v ON t.active_version_id = v.id
       WHERE t.slug = $1 LIMIT 1`,
      [slug],
    );
    if (rows.length === 0) return null;
    return this.mapVersionRow(rows[0]);
  }

  async listVersions(templateId: string): Promise<PromptVersion[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ai_prompt_versions 
       WHERE template_id = $1 
       ORDER BY version_number DESC`,
      [templateId],
    );
    return rows.map((r) => this.mapVersionRow(r));
  }

  async findVersionById(versionId: string): Promise<PromptVersion | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ai_prompt_versions WHERE id = $1 LIMIT 1`,
      [versionId],
    );
    if (rows.length === 0) return null;
    return this.mapVersionRow(rows[0]);
  }

  async createVersion(input: CreatePromptVersionInput): Promise<PromptVersion> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Obtener el siguiente número de versión
      const versionResult = await client.query<{ max_version: number | null }>(
        `SELECT MAX(version_number) AS max_version FROM ai_prompt_versions WHERE template_id = $1`,
        [input.templateId],
      );
      const nextVersion = (versionResult.rows[0]?.max_version ?? 0) + 1;

      const isPublished = input.status === "PUBLISHED";
      const publishedAt = isPublished ? new Date() : null;

      const insertResult = await client.query(
        `INSERT INTO ai_prompt_versions (
           template_id, version_number, system_prompt, user_template, 
           model_config, status, change_notes, created_by, published_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          input.templateId,
          nextVersion,
          input.systemPrompt,
          input.userTemplate,
          JSON.stringify(input.modelConfig || { temperature: 0.2, max_tokens: 1024 }),
          input.status || "DRAFT",
          input.changeNotes ?? null,
          input.createdBy ?? null,
          publishedAt,
        ],
      );

      const createdVersion = this.mapVersionRow(insertResult.rows[0]);

      if (isPublished) {
        // Archivar la versión previa activa si existía
        await client.query(
          `UPDATE ai_prompt_versions 
           SET status = 'ARCHIVED' 
           WHERE template_id = $1 AND id != $2 AND status = 'PUBLISHED'`,
          [input.templateId, createdVersion.id],
        );

        // Actualizar puntero en template
        await client.query(
          `UPDATE ai_prompt_templates 
           SET active_version_id = $1, updated_at = now() 
           WHERE id = $2`,
          [createdVersion.id, input.templateId],
        );
      }

      await client.query("COMMIT");
      return createdVersion;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async setActiveVersion(templateId: string, versionId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Archivar versiones publicadas anteriores
      await client.query(
        `UPDATE ai_prompt_versions 
         SET status = 'ARCHIVED' 
         WHERE template_id = $1 AND id != $2 AND status = 'PUBLISHED'`,
        [templateId, versionId],
      );

      // Publicar la nueva versión activa
      await client.query(
        `UPDATE ai_prompt_versions 
         SET status = 'PUBLISHED', published_at = now() 
         WHERE id = $1`,
        [versionId],
      );

      // Actualizar puntero en template
      await client.query(
        `UPDATE ai_prompt_templates 
         SET active_version_id = $1, updated_at = now() 
         WHERE id = $2`,
        [versionId, templateId],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private mapTemplateRow(r: DbTemplateRow): PromptTemplate {
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      departmentId: r.department_id,
      allowedVariables: Array.isArray(r.allowed_variables) ? r.allowed_variables : [],
      variableDefinitions: Array.isArray(r.variable_definitions) ? r.variable_definitions : [],
      activeVersionId: r.active_version_id,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }

  private mapVersionRow(r: DbVersionRow): PromptVersion {
    return {
      id: r.id,
      templateId: r.template_id,
      versionNumber: r.version_number,
      systemPrompt: r.system_prompt,
      userTemplate: r.user_template,
      modelConfig:
        typeof r.model_config === "string"
          ? JSON.parse(r.model_config)
          : (r.model_config as Record<string, unknown>) || {},
      status: r.status,
      changeNotes: r.change_notes,
      createdBy: r.created_by,
      publishedAt: r.published_at ? new Date(r.published_at) : null,
      createdAt: new Date(r.created_at),
    };
  }
}

interface DbTemplateRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  department_id: string | null;
  allowed_variables: unknown;
  variable_definitions: unknown;
  active_version_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface DbVersionRow {
  id: string;
  template_id: string;
  version_number: number;
  system_prompt: string;
  user_template: string;
  model_config: unknown;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  change_notes: string | null;
  created_by: string | null;
  published_at: string | Date | null;
  created_at: string | Date;
}
