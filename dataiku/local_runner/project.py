"""Typed, validated view of the DSS project export in `dataiku/project/`.

Only the keys the local runner needs are modelled; DSS-only keys are ignored, not rejected.
"""

from dataclasses import dataclass
from graphlib import CycleError, TopologicalSorter
from pathlib import Path
from typing import Annotated, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from local_runner.errors import ProjectDefinitionError


class FrozenModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)


ModelT = TypeVar("ModelT", bound=BaseModel)


DssColumnType = Literal[
    "string", "smallint", "int", "bigint", "double", "boolean", "date", "dateonly"
]


class DssColumn(FrozenModel):
    name: str
    type: DssColumnType


class DssSchema(FrozenModel):
    columns: tuple[DssColumn, ...]


class SqlTableParams(FrozenModel):
    connection: str
    mode: Literal["table"]
    # None: the connection's default schema (DSS-managed datasets; temp tables locally).
    db_schema: str | None = Field(default=None, alias="schema")
    table: str


class DatasetDefinition(FrozenModel):
    type: Literal["PostgreSQL"]
    managed: bool
    params: SqlTableParams
    dss_schema: DssSchema = Field(alias="schema")

    def column_names(self) -> list[str]:
        return [column.name for column in self.dss_schema.columns]


class RecipeItem(FrozenModel):
    ref: str


class RecipeRole(FrozenModel):
    items: tuple[RecipeItem, ...]


class RecipeRoles(FrozenModel):
    main: RecipeRole

    def refs(self) -> list[str]:
        return [item.ref for item in self.main.items]


class RecipeDefinition(FrozenModel):
    type: Literal["sync", "sql_query", "python"]
    inputs: RecipeRoles
    outputs: RecipeRoles


_CODE_SUFFIXES = {"sql_query": ".sql", "python": ".py"}


@dataclass(frozen=True)
class Recipe:
    name: str
    definition: RecipeDefinition
    folder: Path

    def code_path(self) -> Path:
        """The recipe's code file (`<name>.sql` / `<name>.py`); sync recipes have none."""
        suffix = _CODE_SUFFIXES.get(self.definition.type)
        if suffix is None:
            message = f"recipe {self.name} is a {self.definition.type} recipe and has no code"
            raise ProjectDefinitionError(message)
        return self.folder / f"{self.name}{suffix}"

    def code(self) -> str:
        return self.code_path().read_text(encoding="utf-8")

    def single_input(self) -> str:
        return _single(self.name, "input", self.definition.inputs.refs())

    def single_output(self) -> str:
        return _single(self.name, "output", self.definition.outputs.refs())


class TemporalTriggerParams(FrozenModel):
    frequency: str
    hour: int
    minute: int
    timezone: str


class TemporalTrigger(FrozenModel):
    type: Literal["temporal"]
    params: TemporalTriggerParams


class FlowItemRef(FrozenModel):
    item_id: str = Field(alias="itemId")


class BuildStepParams(FrozenModel):
    builds: tuple[FlowItemRef, ...]


class BuildStep(FrozenModel):
    type: Literal["build_flowitem"]
    params: BuildStepParams


class CheckStepParams(FrozenModel):
    checks: tuple[FlowItemRef, ...]


class CheckStep(FrozenModel):
    type: Literal["check_dataset"]
    params: CheckStepParams


class OtherStep(FrozenModel):
    type: Literal["set_project_vars"]


ScenarioStep = Annotated[BuildStep | CheckStep | OtherStep, Field(discriminator="type")]


class ScenarioParams(FrozenModel):
    steps: tuple[ScenarioStep, ...]


class ScenarioDefinition(FrozenModel):
    type: Literal["step_based"]
    triggers: tuple[TemporalTrigger, ...]
    params: ScenarioParams

    def built_datasets(self) -> list[str]:
        return [
            build.item_id
            for step in self.params.steps
            if isinstance(step, BuildStep)
            for build in step.params.builds
        ]

    def checked_datasets(self) -> list[str]:
        return [
            check.item_id
            for step in self.params.steps
            if isinstance(step, CheckStep)
            for check in step.params.checks
        ]

    def trigger_times(self) -> list[tuple[str, int, int, str]]:
        return [
            (t.params.frequency, t.params.hour, t.params.minute, t.params.timezone)
            for t in self.triggers
        ]


class ProjectVariables(FrozenModel):
    standard: dict[str, str]


@dataclass(frozen=True)
class DssProject:
    """The DSS project folder: datasets, recipes, scenarios, variables and checks."""

    root: Path

    def dataset_names(self) -> list[str]:
        return sorted(path.stem for path in (self.root / "datasets").glob("*.json"))

    def dataset(self, name: str) -> DatasetDefinition:
        return load_model(self.root / "datasets" / f"{name}.json", DatasetDefinition)

    def recipes(self) -> list[Recipe]:
        folder = self.root / "recipes"
        return [
            Recipe(name=path.stem, definition=load_model(path, RecipeDefinition), folder=folder)
            for path in sorted(folder.glob("*.json"))
        ]

    def flow_order(self) -> list[Recipe]:
        """Recipes ordered so that each runs after the recipes building its inputs."""
        recipes = self.recipes()
        producers = {
            output: recipe.name for recipe in recipes for output in recipe.definition.outputs.refs()
        }
        graph = {
            recipe.name: {
                producers[ref] for ref in recipe.definition.inputs.refs() if ref in producers
            }
            for recipe in recipes
        }
        try:
            order = list(TopologicalSorter(graph).static_order())
        except CycleError as error:
            message = f"the recipes of {self.root} form a cycle: {error.args[1]}"
            raise ProjectDefinitionError(message) from error
        by_name = {recipe.name: recipe for recipe in recipes}
        return [by_name[name] for name in order]

    def variables(self) -> dict[str, str]:
        return load_model(self.root / "variables.json", ProjectVariables).standard

    def scenario(self, name: str) -> ScenarioDefinition:
        return load_model(self.root / "scenarios" / f"{name}.json", ScenarioDefinition)

    def checks_path(self) -> Path:
        return self.root / "metrics_checks.json"


def load_model(path: Path, model: type[ModelT]) -> ModelT:
    """Parse the JSON file `path` as `model`; missing or malformed is a ProjectDefinitionError."""
    try:
        return model.model_validate_json(path.read_bytes())
    except FileNotFoundError as error:
        message = f"{path} is missing from the DSS project"
        raise ProjectDefinitionError(message) from error
    except ValidationError as error:
        message = f"{path} does not match the expected {model.__name__} shape: {error}"
        raise ProjectDefinitionError(message) from error


def _single(recipe: str, role: str, refs: list[str]) -> str:
    if len(refs) != 1:
        message = f"recipe {recipe} must have exactly one {role}, found {refs}"
        raise ProjectDefinitionError(message)
    return refs[0]
