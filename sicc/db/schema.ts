import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const people = sqliteTable("people", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fullName: text("full_name").notNull(),
  nickname: text("nickname"),
  cpf: text("cpf").notNull().unique(),
  birthDate: text("birth_date"),
  motherName: text("mother_name"),
  city: text("city"),
  state: text("state"),
  status: text("status", { enum: ["verified", "review", "attention"] }).notNull().default("review"),
  notes: text("notes"),
  factionId: integer("faction_id"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("people_full_name_idx").on(table.fullName)]);

export const addresses = sqliteTable("addresses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  personId: integer("person_id").notNull(),
  label: text("label").notNull().default("Residencial"),
  address: text("address").notNull(),
  city: text("city"),
  state: text("state"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("addresses_person_idx").on(table.personId)]);

export const factions = sqliteTable("factions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const approaches = sqliteTable("approaches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  personId: integer("person_id").notNull(),
  occurredAt: text("occurred_at").notNull(),
  latitude: text("latitude").notNull(),
  longitude: text("longitude").notNull(),
  accuracyMeters: integer("accuracy_meters"),
  locationLabel: text("location_label"),
  notes: text("notes"),
  operatorEmail: text("operator_email").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("approaches_person_idx").on(table.personId),
  index("approaches_date_idx").on(table.occurredAt),
]);

export const seizedObjects = sqliteTable("seized_objects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  personId: integer("person_id").notNull(),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull().default(1),
  seizedAt: text("seized_at"),
  location: text("location"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("seized_objects_person_idx").on(table.personId)]);

export const personMedia = sqliteTable("person_media", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  personId: integer("person_id").notNull(),
  kind: text("kind", { enum: ["face", "face_front", "face_profile", "tattoo"] }).notNull(),
  objectKey: text("object_key").notNull().unique(),
  originalName: text("original_name").notNull(),
  contentType: text("content_type").notNull(),
  sha256: text("sha256").notNull(),
  faceEmbedding: text("face_embedding"),
  description: text("description"),
  capturedAt: text("captured_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("person_media_person_idx").on(table.personId),
  index("person_media_hash_idx").on(table.sha256),
]);

export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  operatorEmail: text("operator_email").notNull(),
  action: text("action").notNull(),
  targetId: integer("target_id"),
  query: text("query"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("audit_created_at_idx").on(table.createdAt)]);

export const operators = sqliteTable("operators", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  nameRank: text("name_rank").notNull(),
  warName: text("war_name").notNull().default(""),
  rank: text("rank").notNull().default(""),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  role: text("role", { enum: ["admin", "operator"] }).notNull().default("operator"),
  invitedBy: integer("invited_by"),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: text("locked_until"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("operators_invited_by_idx").on(table.invitedBy)]);

export const operatorInvites = sqliteTable("operator_invites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  codeHash: text("code_hash").notNull().unique(),
  createdBy: integer("created_by").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  usedBy: integer("used_by"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("operator_invites_creator_idx").on(table.createdBy)]);

export const operatorSessions = sqliteTable("operator_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  operatorId: integer("operator_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("operator_sessions_operator_idx").on(table.operatorId)]);
