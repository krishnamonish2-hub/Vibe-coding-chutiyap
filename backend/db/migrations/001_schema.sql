-- MessMind Phase 2 schema (docs/architecture.md §4). All simulation data is synthetic.
-- Applied inside one transaction by backend/src/db/migrate.js: do NOT add BEGIN/COMMIT here.
-- Objects are created unqualified so the migration can run in any schema (tests use throw-away schemas).
-- Fixed values encode approved decisions: 1,000 students, learning Days 1-30, predictions from Day 31 (R-02..R-04),
-- meal schedule offsets and serve times (D1, D2).

-- ---------------------------------------------------------------------------
-- Reference data: students, users, dishes
-- ---------------------------------------------------------------------------
CREATE TABLE students (
  id   integer PRIMARY KEY CHECK (id BETWEEN 1 AND 1000),
  code text    NOT NULL UNIQUE CHECK (code ~ '^S[0-9]{4}$'),
  CHECK (code = 'S' || lpad(id::text, 4, '0'))
);

CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         text        NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  password_hash text        NOT NULL CHECK (length(password_hash) > 0),
  role          text        NOT NULL CHECK (role IN ('admin', 'student')),
  student_id    integer     UNIQUE REFERENCES students (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- students are linked to exactly one synthetic student; admins to none
  CHECK ((role = 'student') = (student_id IS NOT NULL))
);

CREATE TABLE dishes (
  id           text             PRIMARY KEY CHECK (id ~ '^D[0-9]{3}$'),
  display_name text             NOT NULL CHECK (display_name = btrim(display_name) AND length(display_name) BETWEEN 1 AND 100),
  ml_dish_name text             NOT NULL UNIQUE CHECK (ml_dish_name = btrim(ml_dish_name) AND length(ml_dish_name) BETWEEN 1 AND 100),
  category     text             NOT NULL CHECK (category IN ('staple_rice', 'bread', 'dal', 'main_veg', 'main_nonveg',
                                                             'side', 'dessert', 'beverage', 'breakfast_item', 'fruit')),
  is_veg       boolean          NOT NULL,
  portion_kg   double precision NOT NULL CHECK (portion_kg > 0 AND portion_kg <= 2),
  active       boolean          NOT NULL DEFAULT true,
  created_at   timestamptz      NOT NULL DEFAULT now(),
  updated_at   timestamptz      NOT NULL DEFAULT now(),
  UNIQUE (id, ml_dish_name)     -- target of meal_dishes' composite FK (menu copy must use the real ML name)
);

-- Stable dish identity (R-08): id and ml_dish_name can never change. Only display fields may be edited.
CREATE FUNCTION dishes_guard_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'dishes.id is immutable (% -> %)', OLD.id, NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ml_dish_name IS DISTINCT FROM OLD.ml_dish_name THEN
    RAISE EXCEPTION 'dishes.ml_dish_name is immutable for % (% -> %)', OLD.id, OLD.ml_dish_name, NEW.ml_dish_name
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER dishes_guard_identity BEFORE UPDATE ON dishes
  FOR EACH ROW EXECUTE FUNCTION dishes_guard_identity();

-- ---------------------------------------------------------------------------
-- Simulation runs and calendar (everything below is deleted with its run)
-- ---------------------------------------------------------------------------
CREATE TABLE simulation_runs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status             text        NOT NULL DEFAULT 'paused' CHECK (status IN ('running', 'paused', 'completed')),
  seed               bigint      NOT NULL,
  start_date         date        NOT NULL,                                   -- date of Day 1
  total_days         integer     NOT NULL DEFAULT 60 CHECK (total_days BETWEEN 31 AND 366),
  learning_days      integer     NOT NULL DEFAULT 30 CHECK (learning_days = 30),
  activation_day     integer     NOT NULL DEFAULT 31 CHECK (activation_day = 31),
  total_students     integer     NOT NULL DEFAULT 1000 CHECK (total_students = 1000),
  speed_sim_minutes  integer     NOT NULL DEFAULT 15 CHECK (speed_sim_minutes BETWEEN 1 AND 1440),  -- per real second
  sim_now            timestamptz NOT NULL,
  calendar_config    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- the clock never runs before Day 0 19:30 (UTC), the approved run start
  CHECK (sim_now >= ((start_date - 1)::timestamp + interval '19 hours 30 minutes') AT TIME ZONE 'UTC')
);
-- at most one run exists at a time (reset deletes it)
CREATE UNIQUE INDEX simulation_runs_single ON simulation_runs ((true));

CREATE TABLE sim_days (
  run_id      bigint           NOT NULL REFERENCES simulation_runs (id) ON DELETE CASCADE,
  day_number  integer          NOT NULL CHECK (day_number BETWEEN 1 AND 366),
  date        date             NOT NULL,
  is_weekend  boolean          NOT NULL,
  is_holiday  boolean          NOT NULL DEFAULT false,
  is_exam_day boolean          NOT NULL DEFAULT false,
  is_festival boolean          NOT NULL DEFAULT false,
  temperature double precision NOT NULL CHECK (temperature BETWEEN -30 AND 60),
  rainfall    double precision NOT NULL CHECK (rainfall >= 0),
  PRIMARY KEY (run_id, day_number),
  UNIQUE (run_id, date),
  UNIQUE (run_id, day_number, date),   -- target of meals' composite FK
  CHECK (is_weekend = (extract(isodow FROM date) IN (6, 7)))
);

-- ---------------------------------------------------------------------------
-- Meals and menus
-- ---------------------------------------------------------------------------
CREATE TABLE meals (
  id                    text        PRIMARY KEY,
  run_id                bigint      NOT NULL,
  day_number            integer     NOT NULL,
  date                  date        NOT NULL,
  meal_type             text        NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner')),
  serve_at              timestamptz NOT NULL,
  voting_opens_at       timestamptz NOT NULL,
  provisional_at        timestamptz NOT NULL,
  voting_closes_at      timestamptz NOT NULL,
  completes_at          timestamptz NOT NULL,
  phase                 text        NOT NULL CHECK (phase IN ('learning', 'active')),
  status                text        NOT NULL DEFAULT 'scheduled'
                        CHECK (status IN ('scheduled', 'voting_open', 'provisional_taken', 'voting_closed', 'completed')),
  prov_total_responses  integer     CHECK (prov_total_responses BETWEEN 0 AND 1000),
  prov_not_eating       integer     CHECK (prov_not_eating >= 0 AND prov_not_eating <= prov_total_responses),
  final_total_responses integer     CHECK (final_total_responses BETWEEN 0 AND 1000),
  final_not_eating      integer     CHECK (final_not_eating >= 0 AND final_not_eating <= final_total_responses),
  headcount             integer     CHECK (headcount BETWEEN 0 AND 1000),
  FOREIGN KEY (run_id) REFERENCES simulation_runs (id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, day_number, date) REFERENCES sim_days (run_id, day_number, date) ON DELETE CASCADE,
  UNIQUE (run_id, date, meal_type),
  UNIQUE (run_id, day_number, meal_type),
  -- ML meal_id: r{run}-d{day:03}-{meal_type} (<= 100 characters)
  CHECK (id = 'r' || run_id || '-d' || lpad(day_number::text, 3, '0') || '-' || meal_type),
  -- D2 serve times (UTC simulated clock) on the meal's own date
  CHECK ((serve_at AT TIME ZONE 'UTC')::date = date),
  CHECK ((serve_at AT TIME ZONE 'UTC')::time = CASE meal_type WHEN 'breakfast' THEN time '07:30'
                                                              WHEN 'lunch'     THEN time '12:30'
                                                              ELSE                  time '19:30' END),
  -- D2 offsets: open -12h, provisional -4h, close -30m, complete +45m
  CHECK (voting_opens_at  = serve_at - interval '12 hours'),
  CHECK (provisional_at   = serve_at - interval '4 hours'),
  CHECK (voting_closes_at = serve_at - interval '30 minutes'),
  CHECK (completes_at     = serve_at + interval '45 minutes'),
  -- R-03/R-04: learning Days 1-30, predictions from Day 31
  CHECK (phase = CASE WHEN day_number >= 31 THEN 'active' ELSE 'learning' END),
  -- frozen counts exist exactly when the meal has passed the corresponding step
  CHECK ((prov_total_responses IS NULL) = (status IN ('scheduled', 'voting_open'))),
  CHECK ((prov_not_eating IS NULL) = (prov_total_responses IS NULL)),
  CHECK ((final_total_responses IS NULL) = (status IN ('scheduled', 'voting_open', 'provisional_taken'))),
  CHECK ((final_not_eating IS NULL) = (final_total_responses IS NULL)),
  CHECK ((headcount IS NULL) = (status <> 'completed'))
);
CREATE INDEX meals_history ON meals (run_id, meal_type, serve_at);
CREATE INDEX meals_run_serve ON meals (run_id, serve_at);

CREATE TABLE meal_dishes (
  meal_id      text    NOT NULL REFERENCES meals (id) ON DELETE CASCADE,
  dish_id      text    NOT NULL,
  ml_dish_name text    NOT NULL,
  display_name text    NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),   -- copy at publish time
  category     text    NOT NULL,
  is_veg       boolean NOT NULL,
  is_special   boolean NOT NULL DEFAULT false,
  position     integer NOT NULL CHECK (position BETWEEN 1 AND 30),
  PRIMARY KEY (meal_id, dish_id),
  UNIQUE (meal_id, ml_dish_name),     -- ML requires unique dish_name per meal
  UNIQUE (meal_id, position),
  -- the copied ML name must be the dish's real (immutable) ML name
  FOREIGN KEY (dish_id, ml_dish_name) REFERENCES dishes (id, ml_dish_name)
);
CREATE INDEX meal_dishes_dish ON meal_dishes (dish_id);

-- ---------------------------------------------------------------------------
-- Student responses (R-07) and dish picks — composite foreign keys (decisions.md change log)
-- ---------------------------------------------------------------------------
CREATE TABLE meal_responses (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meal_id      text        NOT NULL REFERENCES meals (id) ON DELETE CASCADE,
  student_id   integer     NOT NULL REFERENCES students (id),
  response     text        NOT NULL CHECK (response IN ('eating', 'not_eating')),
  responded_at timestamptz NOT NULL,
  UNIQUE (meal_id, student_id),
  UNIQUE (id, meal_id, response)          -- target of response_picks' composite FK
);
CREATE INDEX meal_responses_meal_time ON meal_responses (meal_id, responded_at);

CREATE TABLE response_picks (
  response_id bigint NOT NULL,
  meal_id     text   NOT NULL,
  dish_id     text   NOT NULL,
  response    text   NOT NULL DEFAULT 'eating' CHECK (response = 'eating'),
  PRIMARY KEY (response_id, dish_id),
  -- the pick belongs to this response, of this meal, and that response is 'eating'
  FOREIGN KEY (response_id, meal_id, response)
    REFERENCES meal_responses (id, meal_id, response) ON DELETE CASCADE ON UPDATE CASCADE,
  -- the dish is on the same meal's menu
  FOREIGN KEY (meal_id, dish_id)
    REFERENCES meal_dishes (meal_id, dish_id) ON DELETE CASCADE
);
CREATE INDEX response_picks_meal_dish ON response_picks (meal_id, dish_id);

-- Frozen tap counts per dish (provisional at T-4h, final at T-30m)
CREATE TABLE meal_dish_counts (
  meal_id    text    NOT NULL,
  dish_id    text    NOT NULL,
  prov_taps  integer CHECK (prov_taps BETWEEN 0 AND 1000),
  final_taps integer CHECK (final_taps BETWEEN 0 AND 1000),
  PRIMARY KEY (meal_id, dish_id),
  FOREIGN KEY (meal_id, dish_id) REFERENCES meal_dishes (meal_id, dish_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Predictions (stored separately from actual outcomes)
-- ---------------------------------------------------------------------------
CREATE TABLE prediction_requests (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meal_id          text        NOT NULL REFERENCES meals (id) ON DELETE CASCADE,
  kind             text        NOT NULL CHECK (kind IN ('provisional', 'final')),
  attempt          integer     NOT NULL CHECK (attempt >= 1),
  status           text        NOT NULL CHECK (status IN ('ok', 'error', 'unavailable')),
  is_current       boolean     NOT NULL DEFAULT false,
  request_payload  jsonb       NOT NULL,
  response_payload jsonb,
  http_status      integer     CHECK (http_status BETWEEN 100 AND 599),
  error_detail     jsonb,
  model_version    text,
  trained_on       text,
  sim_at           timestamptz NOT NULL,
  wall_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meal_id, kind, attempt),
  UNIQUE (id, meal_id),                   -- target of prediction_items' composite FK
  CHECK (status <> 'ok' OR (response_payload IS NOT NULL AND model_version IS NOT NULL AND trained_on IS NOT NULL))
);
CREATE UNIQUE INDEX prediction_requests_current ON prediction_requests (meal_id, kind) WHERE is_current;

CREATE TABLE prediction_items (
  request_id          bigint           NOT NULL,
  meal_id             text             NOT NULL,
  dish_id             text             NOT NULL,
  interested_taps     integer          NOT NULL CHECK (interested_taps BETWEEN 0 AND 1000),
  predicted_consumers integer          NOT NULL CHECK (predicted_consumers BETWEEN 0 AND 1000),
  warnings            text[]           NOT NULL DEFAULT '{}',
  hist_demand         double precision CHECK (hist_demand >= 0),
  hist_rating         double precision CHECK (hist_rating BETWEEN 1 AND 5),
  prev_leftover_kg    double precision CHECK (prev_leftover_kg >= 0),
  PRIMARY KEY (request_id, dish_id),
  FOREIGN KEY (request_id, meal_id) REFERENCES prediction_requests (id, meal_id) ON DELETE CASCADE,
  FOREIGN KEY (meal_id, dish_id) REFERENCES meal_dishes (meal_id, dish_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Actual outcomes (synthetic, entered by the simulator or edited by the admin)
-- ---------------------------------------------------------------------------
CREATE TABLE dish_outcomes (
  meal_id                 text             NOT NULL,
  dish_id                 text             NOT NULL,
  actual_consumers        integer          NOT NULL CHECK (actual_consumers BETWEEN 0 AND 1000),
  prepared_servings       integer          NOT NULL CHECK (prepared_servings >= 0),
  static_plan_servings    integer          NOT NULL CHECK (static_plan_servings >= 0),
  leftover_kg             double precision NOT NULL CHECK (leftover_kg >= 0),
  static_plan_leftover_kg double precision NOT NULL CHECK (static_plan_leftover_kg >= 0),
  shortfall_servings      integer          NOT NULL DEFAULT 0 CHECK (shortfall_servings >= 0),
  avg_rating              double precision CHECK (avg_rating BETWEEN 1 AND 5),
  source                  text             NOT NULL DEFAULT 'simulated' CHECK (source IN ('simulated', 'admin')),
  edited_at               timestamptz,
  PRIMARY KEY (meal_id, dish_id),
  FOREIGN KEY (meal_id, dish_id) REFERENCES meal_dishes (meal_id, dish_id) ON DELETE CASCADE,
  CHECK ((source = 'admin') = (edited_at IS NOT NULL))
);
CREATE INDEX dish_outcomes_dish ON dish_outcomes (dish_id);

-- ---------------------------------------------------------------------------
-- Audit log: durable and append-only; no FK to runs, so it survives a reset (D6)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  user_id bigint      REFERENCES users (id) ON DELETE SET NULL,
  action  text        NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  entity  text        NOT NULL CHECK (length(entity) BETWEEN 1 AND 200),
  before  jsonb,
  after   jsonb
);
CREATE INDEX audit_log_at ON audit_log (at);

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The only permitted change: user_id cleared by ON DELETE SET NULL when a user is deleted.
  IF TG_OP = 'UPDATE' AND OLD.user_id IS NOT NULL AND NEW.user_id IS NULL
     AND (NEW.id, NEW.at, NEW.action, NEW.entity, NEW.before, NEW.after)
         IS NOT DISTINCT FROM (OLD.id, OLD.at, OLD.action, OLD.entity, OLD.before, OLD.after) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
