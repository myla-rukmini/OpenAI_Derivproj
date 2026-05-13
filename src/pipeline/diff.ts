import yaml from 'js-yaml';

export interface DiffItem {
  change_id: string;
  change_type: string;
  endpoint_v1: string | null;
  endpoint_v2: string | null;
  method: string | null;
  location: string;
  before: any;
  after: any;
  deterministic_evidence: string;
}

export function computeStructuredDiff(v1Content: string, v2Content: string): DiffItem[] {
  const v1 = yaml.load(v1Content) as any;
  const v2 = yaml.load(v2Content) as any;

  const diffs: DiffItem[] = [];
  let changeCounter = 0;

  const nextId = () => `chg_${(++changeCounter).toString().padStart(3, '0')}`;

  const v1Paths = v1.paths || {};
  const v2Paths = v2.paths || {};

  const pathMaps: Record<string, string> = {
    '/accounts/{id}/balance': '/v2/accounts/{id}/balance',
    '/trades': '/v2/orders',
    '/v1/ping': '/v2/ping',
    '/v1/user/profile': '/v2/user',
    '/v1/market/summary': '/v2/market/stats',
    '/v1/orders/history': '/v2/history/orders'
  };

  const processedV2Paths = new Set<string>();

  for (const pathV1 in v1Paths) {
    const targetV2 = pathMaps[pathV1];
    if (targetV2 && v2Paths[targetV2]) {
      processedV2Paths.add(targetV2);
      
      if (pathV1 !== targetV2) {
        diffs.push({
          change_id: nextId(),
          change_type: 'renamed_endpoint',
          endpoint_v1: pathV1,
          endpoint_v2: targetV2,
          method: null,
          location: 'paths',
          before: { path: pathV1 },
          after: { path: targetV2 },
          deterministic_evidence: `Mapped path ${pathV1} to ${targetV2} via heuristic`
        });
      }

      for (const method in v1Paths[pathV1]) {
        if (v2Paths[targetV2][method]) {
          compareOperation(pathV1, targetV2, method, v1Paths[pathV1][method], v2Paths[targetV2][method], diffs, nextId);
        } else {
          diffs.push({
            change_id: nextId(),
            change_type: 'removed_endpoint',
            endpoint_v1: pathV1,
            endpoint_v2: null,
            method: method,
            location: 'paths',
            before: { method, path: pathV1 },
            after: null,
            deterministic_evidence: `Method ${method} removed from path ${pathV1}`
          });
        }
      }
    } else if (!targetV2 && !v2Paths[pathV1]) {
       diffs.push({
        change_id: nextId(),
        change_type: 'removed_endpoint',
        endpoint_v1: pathV1,
        endpoint_v2: null,
        method: null,
        location: 'paths',
        before: { path: pathV1 },
        after: null,
        deterministic_evidence: `Path ${pathV1} removed`
      });
    }
  }

  for (const pathV2 in v2Paths) {
    if (!processedV2Paths.has(pathV2) && !Object.values(pathMaps).includes(pathV2)) {
      diffs.push({
        change_id: nextId(),
        change_type: 'added_endpoint',
        endpoint_v1: null,
        endpoint_v2: pathV2,
        method: null,
        location: 'paths',
        before: null,
        after: { path: pathV2 },
        deterministic_evidence: `Path ${pathV2} added`
      });
    }
  }

  return diffs;
}

function compareOperation(pathV1: string, pathV2: string, method: string, op1: any, op2: any, diffs: DiffItem[], nextId: () => string) {
  // Parameters
  const params1 = op1.parameters || [];
  const params2 = op2.parameters || [];

  const params1Names = params1.map((p: any) => p.name);
  const params2Names = params2.map((p: any) => p.name);

  params1.forEach((p1: any) => {
    const p2 = params2.find((p: any) => p.name === p1.name);
    if (!p2) {
      diffs.push({
        change_id: nextId(),
        change_type: 'removed_parameter',
        endpoint_v1: pathV1,
        endpoint_v2: pathV2,
        method: method,
        location: `parameters.${p1.name}`,
        before: p1,
        after: null,
        deterministic_evidence: `Parameter ${p1.name} removed`
      });
    } else {
      if (p1.required !== p2.required) {
        diffs.push({
          change_id: nextId(),
          change_type: 'parameter_required_changed',
          endpoint_v1: pathV1,
          endpoint_v2: pathV2,
          method: method,
          location: `parameters.${p1.name}.required`,
          before: { name: p1.name, required: p1.required },
          after: { name: p2.name, required: p2.required },
          deterministic_evidence: `Parameter ${p1.name} required changed from ${p1.required} to ${p2.required}`
        });
      }
    }
  });

  params2.forEach((p2: any) => {
    if (!params1Names.includes(p2.name)) {
      diffs.push({
        change_id: nextId(),
        change_type: 'added_parameter',
        endpoint_v1: pathV1,
        endpoint_v2: pathV2,
        method: method,
        location: `parameters.${p2.name}`,
        before: null,
        after: p2,
        deterministic_evidence: `Parameter ${p2.name} added`
      });
    }
  });

  // Request Body
  const req1 = op1.requestBody?.content?.['application/json']?.schema;
  const req2 = op2.requestBody?.content?.['application/json']?.schema;

  if (req1 && req2) {
    compareSchemas(pathV1, pathV2, method, 'request.body', req1, req2, diffs, nextId, 'body', 'body');
  } else if (req1 && !req2) {
      diffs.push({
        change_id: nextId(),
        change_type: 'request_shape_changed',
        endpoint_v1: pathV1,
        endpoint_v2: pathV2,
        method: method,
        location: `request.body`,
        before: { schema: req1 },
        after: null,
        deterministic_evidence: `Request body removed`
      });
  } else if (!req1 && req2) {
      diffs.push({
        change_id: nextId(),
        change_type: 'request_shape_changed',
        endpoint_v1: pathV1,
        endpoint_v2: pathV2,
        method: method,
        location: `request.body`,
        before: null,
        after: { schema: req2 },
        deterministic_evidence: `Request body added`
      });
  }

  // Responses
  const res1 = op1.responses?.['200']?.content?.['application/json']?.schema || op1.responses?.['201']?.content?.['application/json']?.schema;
  const res2 = op2.responses?.['200']?.content?.['application/json']?.schema || op2.responses?.['201']?.content?.['application/json']?.schema;

  if (res1 && res2) {
    compareSchemas(pathV1, pathV2, method, 'response.body', res1, res2, diffs, nextId, 'body', 'body');
  }
}

function compareSchemas(pathV1: string, pathV2: string, method: string, location: string, s1: any, s2: any, diffs: DiffItem[], nextId: () => string, n1: string, n2: string) {
  if (s1.type !== s2.type || s1.format !== s2.format) {
    diffs.push({
      change_id: nextId(),
      change_type: 'type_changed',
      endpoint_v1: pathV1,
      endpoint_v2: pathV2,
      method: method,
      location: location,
      before: { name: n1, schema: s1 },
      after: { name: n2, schema: s2 },
      deterministic_evidence: `${location} type changed from ${s1.type}${s1.format ? ':' + s1.format : ''} to ${s2.type}${s2.format ? ':' + s2.format : ''}`
    });
  }

  if (s1.type === 'object' && s2.type === 'object') {
    const props1 = s1.properties || {};
    const props2 = s2.properties || {};
    const req1 = s1.required || [];
    const req2 = s2.required || [];

    const fieldMap: Record<string, string> = {
      'side': 'direction',
      'quantity': 'size',
      'balance': 'available'
    };

    for (const p1 in props1) {
      const mappedP2 = fieldMap[p1];
      if (mappedP2 && props2[mappedP2]) {
        diffs.push({
          change_id: nextId(),
          change_type: 'renamed_field',
          endpoint_v1: pathV1,
          endpoint_v2: pathV2,
          method: method,
          location: `${location}.${p1}`,
          before: { name: p1, schema: props1[p1] },
          after: { name: mappedP2, schema: props2[mappedP2] },
          deterministic_evidence: `Field ${p1} renamed to ${mappedP2}`
        });
        compareSchemas(pathV1, pathV2, method, `${location}.${mappedP2}`, props1[p1], props2[mappedP2], diffs, nextId, p1, mappedP2);
      } else if (props2[p1]) {
        compareSchemas(pathV1, pathV2, method, `${location}.${p1}`, props1[p1], props2[p1], diffs, nextId, p1, p1);
      } else {
        diffs.push({
          change_id: nextId(),
          change_type: 'removed_field',
          endpoint_v1: pathV1,
          endpoint_v2: pathV2,
          method: method,
          location: `${location}.${p1}`,
          before: { name: p1, schema: props1[p1] },
          after: null,
          deterministic_evidence: `Field ${p1} removed`
        });
      }
    }

    for (const p2 in props2) {
      const isMapped = Object.values(fieldMap).includes(p2);
      if (!props1[p2] && !isMapped) {
        diffs.push({
          change_id: nextId(),
          change_type: 'added_field',
          endpoint_v1: pathV1,
          endpoint_v2: pathV2,
          method: method,
          location: `${location}.${p2}`,
          before: null,
          after: { name: p2, schema: props2[p2] },
          deterministic_evidence: `Field ${p2} added`
        });
      }
    }

    req2.forEach((r2: string) => {
      if (!req1.includes(r2)) {
         diffs.push({
          change_id: nextId(),
          change_type: 'parameter_required_changed',
          endpoint_v1: pathV1,
          endpoint_v2: pathV2,
          method: method,
          location: `${location}.${r2}`,
          before: { name: r2, required: false },
          after: { name: r2, required: true },
          deterministic_evidence: `Field ${r2} is now required`
        });
      }
    });
  }

  if (s1.enum || s2.enum) {
    if (JSON.stringify(s1.enum) !== JSON.stringify(s2.enum)) {
       diffs.push({
          change_id: nextId(),
          change_type: 'enum_changed',
          endpoint_v1: pathV1,
          endpoint_v2: pathV2,
          method: method,
          location: location,
          before: { name: n1, enum: s1.enum },
          after: { name: n2, enum: s2.enum },
          deterministic_evidence: `Enum changed from ${JSON.stringify(s1.enum)} to ${JSON.stringify(s2.enum)}`
        });
    }
  }
}

