#!/usr/bin/env python3
"""Offline validation for this template pack; never calls AWS or prints values."""

import argparse
import ipaddress
import json
from pathlib import Path
import re
import sys

import yaml


def evaluate_rule(expression, parameters):
    """Evaluate only the parameter-only intrinsic functions used by our Rules."""
    if not isinstance(expression, dict):
        return expression
    if len(expression) != 1:
        raise ValueError("Unsupported template rule expression")
    op, args = next(iter(expression.items()))
    if op == "Ref":
        return parameters[args]
    values = [evaluate_rule(arg, parameters) for arg in args]
    if op == "Fn::Equals":
        return values[0] == values[1]
    if op == "Fn::Not":
        return not values[0]
    if op == "Fn::And":
        return all(values)
    if op == "Fn::Or":
        return any(values)
    raise ValueError("Unsupported template rule function")


def validate(template, entries):
    if not isinstance(entries, list):
        raise ValueError("Expected an AWS CLI JSON parameter array")
    definitions = template.get("Parameters", {})
    supplied = {}
    for item in entries:
        if not isinstance(item, dict) or set(item) != {"ParameterKey", "ParameterValue"}:
            raise ValueError("Each entry must contain ParameterKey and ParameterValue only")
        name, value = item["ParameterKey"], item["ParameterValue"]
        if not isinstance(name, str) or name not in definitions:
            raise ValueError("Unknown parameter name")
        if name in supplied:
            raise ValueError(f"Duplicate parameter: {name}")
        if not isinstance(value, str):
            raise ValueError(f"ParameterValue must be a string: {name}")
        supplied[name] = value

    values = {}
    for name, definition in definitions.items():
        if name not in supplied and "Default" not in definition:
            raise ValueError(f"Missing required parameter: {name}")
        value = supplied.get(name, definition.get("Default"))
        text = str(value)
        if re.search(r"REPLACE|example\.invalid|123456789012|00000000-0000-0000-0000", text, re.I):
            raise ValueError(f"Replace example placeholder: {name}")
        if "AllowedValues" in definition and value not in definition["AllowedValues"]:
            raise ValueError(f"Value not allowed: {name}")
        if "AllowedPattern" in definition and not re.fullmatch(definition["AllowedPattern"], text):
            raise ValueError(f"Invalid format: {name}")
        kind = definition["Type"]
        if kind == "Number":
            try:
                value = int(text)
            except ValueError:
                raise ValueError(f"Expected integer: {name}") from None
            if not definition.get("MinValue", value) <= value <= definition.get("MaxValue", value):
                raise ValueError(f"Number outside allowed range: {name}")
        elif kind == "CommaDelimitedList":
            value = [part.strip() for part in text.split(",")]
        elif kind in ("AWS::EC2::VPC::Id", "AWS::EC2::Subnet::Id"):
            prefix = "vpc" if kind == "AWS::EC2::VPC::Id" else "subnet"
            if not re.fullmatch(prefix + r"-(?:[a-f0-9]{8}|[a-f0-9]{17})", text):
                raise ValueError(f"Invalid AWS ID: {name}")
        if "Cidr" in name and text:
            try:
                ipaddress.IPv4Network(text, strict=True)
            except ValueError:
                raise ValueError(f"Expected canonical IPv4 CIDR: {name}") from None
        values[name] = value

    for rule in template.get("Rules", {}).values():
        for assertion in rule["Assertions"]:
            if not evaluate_rule(assertion["Assert"], values):
                raise ValueError(assertion["AssertDescription"])
    if "BackendPortFrom" in values and values["BackendPortFrom"] > values["BackendPortTo"]:
        raise ValueError("BackendPortFrom must not exceed BackendPortTo")
    if "PortFrom" in values and values["PortFrom"] > values["PortTo"]:
        raise ValueError("PortFrom must not exceed PortTo")
    if values.get("Scheme") == "internal" and values.get("ClientIpv4Cidr"):
        client = ipaddress.IPv4Network(values["ClientIpv4Cidr"])
        private = [ipaddress.IPv4Network(x) for x in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]
        if not any(client.subnet_of(network) for network in private):
            raise ValueError("Internal ALB clients must use an explicit RFC1918 range")
    if values.get("ServiceKind") == "generic":
        paths = values["PathPatterns"]
        if not 1 <= len(paths) <= 3 or any(not path.startswith("/") for path in paths):
            raise ValueError("Generic routes require one to three explicit path patterns starting with /")
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", type=Path)
    parser.add_argument("parameters", type=Path)
    args = parser.parse_args()
    try:
        template = yaml.safe_load(args.template.read_text())
        entries = json.loads(args.parameters.read_text())
        validate(template, entries)
    except (ValueError, OSError, yaml.YAMLError):
        # YAML/JSON parser exceptions can reproduce input values; don't print them.
        # Report controlled validation messages only.
        error = sys.exc_info()[1]
        if type(error) is ValueError:
            print(f"Invalid parameters: {error}", file=sys.stderr)
        else:
            print("Cannot read or parse the template/parameter file", file=sys.stderr)
        return 1
    print("Local parameter checks passed. AWS resources and permissions were not queried.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
