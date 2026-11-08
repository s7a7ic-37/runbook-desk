from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator


class InputModel(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)

    @field_validator('*')
    @classmethod
    def reject_null_characters(cls, value):
        items = value if isinstance(value, list) else [value]
        if any(isinstance(item, str) and '\0' in item for item in items):
            raise ValueError('Text cannot contain null characters.')
        return value


class CaseInput(InputModel):
    title: str = Field(min_length=5, max_length=120)
    description: str = Field(min_length=30, max_length=5000)
    runbook_ids: list[str] = Field(min_length=1, max_length=3)


class Observation(InputModel):
    statement: str = Field(min_length=5, max_length=350)
    source_id: str = Field(min_length=1, max_length=60)


class Check(InputModel):
    action: str = Field(min_length=5, max_length=300)
    reason: str = Field(min_length=5, max_length=300)
    source_ids: list[str] = Field(min_length=1, max_length=3)


class Draft(InputModel):
    summary: str = Field(min_length=10, max_length=500)
    priority: Literal['low', 'medium', 'high']
    observations: list[Observation] = Field(min_length=1, max_length=5)
    checks: list[Check] = Field(min_length=1, max_length=5)
    missing_information: list[str] = Field(max_length=5)
    customer_reply: str = Field(min_length=30, max_length=3000)

    @model_validator(mode='after')
    def known_sources(self, info: ValidationInfo):
        allowed = (info.context or {}).get('source_ids')
        if allowed is not None:
            used = {o.source_id for o in self.observations}
            used.update(source for check in self.checks for source in check.source_ids)
            if not used <= set(allowed) | {'incident'}:
                raise ValueError('The draft cited an unavailable source.')
            if any(not set(check.source_ids) & set(allowed) for check in self.checks):
                raise ValueError('Every check must reference a selected runbook.')
        return self


class ReviewInput(InputModel):
    version: int = Field(ge=0)
    decision: Literal['approved', 'rejected']
    reply: str = Field(min_length=30, max_length=3000)
    note: str = Field(min_length=3, max_length=500)
