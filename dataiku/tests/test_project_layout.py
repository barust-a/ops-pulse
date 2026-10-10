"""The DSS project files are valid and consistent with each other and with ops_kpis."""

from local_runner import PROJECT_DIR
from local_runner.checks import load_checks
from local_runner.project import DssProject
from ops_kpis import BASE_COLUMNS, BASELINE_MIN_DAYS, BASELINE_WINDOW_DAYS, OUTPUT_COLUMNS


def test_every_dataset_definition_parses() -> None:
    project = DssProject(PROJECT_DIR)

    names = project.dataset_names()

    assert names == [
        "changes_raw",
        "daily_service_base",
        "daily_service_kpis",
        "incidents_prepared",
        "incidents_raw",
    ]
    for name in names:
        project.dataset(name)


def test_flow_runs_sync_then_sql_then_python() -> None:
    order = [recipe.name for recipe in DssProject(PROJECT_DIR).flow_order()]

    assert order == [
        "sync_incidents_raw",
        "compute_daily_service_base",
        "compute_daily_service_kpis",
    ]


def test_every_recipe_has_its_code_file() -> None:
    for recipe in DssProject(PROJECT_DIR).flow_order():
        if recipe.definition.type != "sync":
            assert recipe.code_path().is_file(), recipe.name


def test_output_dataset_schema_is_the_ops_daily_service_kpis_contract() -> None:
    dataset = DssProject(PROJECT_DIR).dataset("daily_service_kpis")

    assert dataset.column_names() == list(OUTPUT_COLUMNS)
    assert (dataset.params.db_schema, dataset.params.table) == ("ops", "daily_service_kpis")


def test_base_dataset_schema_provides_every_column_the_python_recipe_needs() -> None:
    columns = DssProject(PROJECT_DIR).dataset("daily_service_base").column_names()

    assert set(BASE_COLUMNS) <= set(columns)


def test_baseline_variables_match_the_library_constants() -> None:
    variables = DssProject(PROJECT_DIR).variables()

    assert variables["kpi_baseline_days"] == str(BASELINE_WINDOW_DAYS)
    assert variables["kpi_baseline_min_days"] == str(BASELINE_MIN_DAYS)


def test_checks_target_columns_of_the_output_dataset() -> None:
    project = DssProject(PROJECT_DIR)
    definition = load_checks(project)
    columns = project.dataset(definition.dataset).column_names()

    checked = {getattr(check, "column", "day") for check in definition.checks}

    assert checked <= set(columns)


def test_scenario_builds_and_checks_the_output_dataset() -> None:
    scenario = DssProject(PROJECT_DIR).scenario("daily_kpis")

    assert scenario.built_datasets() == ["daily_service_kpis"]
    assert scenario.checked_datasets() == ["daily_service_kpis"]
    assert scenario.trigger_times() == [("Daily", 6, 0, "Europe/Paris")]
