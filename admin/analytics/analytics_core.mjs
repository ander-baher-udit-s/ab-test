// Pure query contract, also exercised by Node tests. Snapshot CSVs must be
// authorized and normalized by the server before they reach this module.
export const required = {
  users: ['employee_id', 'name', 'status', 'office'],
  punches: ['punch_id', 'employee_id', 'date', 'timestamp', 'punch_type', 'status', 'reason', 'location_id'],
  approvals: ['punch_id', 'employee_id', 'status', 'timestamp'],
  locations: ['location_id', 'name', 'latitude', 'longitude', 'status'],
  activity: ['activity_id', 'employee_id', 'timestamp', 'nearest_location_id', 'distance_m'],
};
export const quote = value => `'${String(value).replaceAll("'", "''")}'`;
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(value + 'T00:00:00Z'))) throw new Error('Invalid date filter');
  return value;
}
export function predicates(filter, {table = 'p', date = 'date', location = 'location_id'} = {}) {
  const parts = [];
  if (filter.from) parts.push(`${table}.${date} >= ${quote(validDate(filter.from))}`);
  if (filter.to) parts.push(`${table}.${date} <= ${quote(validDate(filter.to))}`);
  if (filter.from && filter.to && filter.from > filter.to) throw new Error('Inverted date range');
  if (filter.employees?.length) parts.push(`${table}.employee_id IN (${filter.employees.map(quote).join(',')})`);
  if (filter.locations?.length) parts.push(`${table}.${location} IN (${filter.locations.map(quote).join(',')})`);
  if (filter.statuses?.length) parts.push(`${table}.status IN (${filter.statuses.map(quote).join(',')})`);
  if (filter.employeeStatus && filter.employeeStatus !== 'all') parts.push(`lower(u.status) = ${quote(filter.employeeStatus)}`);
  return parts.length ? 'WHERE ' + parts.join(' AND ') : '';
}
export function activityPredicates(filter) {
  const parts = [];
  if (filter.from) parts.push(`left(a.timestamp,10) >= ${quote(validDate(filter.from))}`);
  if (filter.to) parts.push(`left(a.timestamp,10) <= ${quote(validDate(filter.to))}`);
  if (filter.employees?.length) parts.push(`a.employee_id IN (${filter.employees.map(quote).join(',')})`);
  if (filter.locations?.length) parts.push(`a.nearest_location_id IN (${filter.locations.map(quote).join(',')})`);
  if (filter.employeeStatus && filter.employeeStatus !== 'all') parts.push(`lower(u.status) = ${quote(filter.employeeStatus)}`);
  // Activity records do not contain attendance status; constrain with a
  // correlated punch on that date, never ignore an active status selection.
  if (filter.statuses?.length) parts.push(`EXISTS (SELECT 1 FROM punch_fact ps
    WHERE ps.employee_id=a.employee_id AND ps.date=left(a.timestamp,10)
      AND ps.status IN (${filter.statuses.map(quote).join(',')}))`);
  return parts.length ? 'WHERE ' + parts.join(' AND ') : '';
}
export const schemas = {
  users: 'employee_id VARCHAR, name VARCHAR, status VARCHAR, office VARCHAR',
  punches: 'punch_id VARCHAR, employee_id VARCHAR, date VARCHAR, timestamp VARCHAR, punch_type VARCHAR, status VARCHAR, reason VARCHAR, reason_code VARCHAR, location_id VARCHAR, latitude VARCHAR, longitude VARCHAR',
  approvals: 'punch_id VARCHAR, employee_id VARCHAR, status VARCHAR, timestamp VARCHAR',
  locations: 'location_id VARCHAR, name VARCHAR, latitude VARCHAR, longitude VARCHAR, status VARCHAR',
  activity: 'activity_id VARCHAR, employee_id VARCHAR, timestamp VARCHAR, nearest_location_id VARCHAR, distance_m VARCHAR, latitude VARCHAR, longitude VARCHAR',
};
export const manualRegularisationReasons = [
  'forgot', 'app issue', 'internet issue', 'weekly off',
  'work from home', 'other',
];
export const leaveRegularisationReasons = [
  'sick leave', 'personal leave', 'compensatory leave',
];
const normalizedReason = (alias, field) =>
  `trim(regexp_replace(lower(coalesce(${alias}.${field},'')),'[^a-z0-9]+',' ','g'))`;
const reasonList = values => `(${values.map(quote).join(',')})`;
export function reasonClassification(alias = 'p') {
  const reason = normalizedReason(alias, 'reason');
  const reasonCode = normalizedReason(alias, 'reason_code');
  const manual = `(${reason} IN ${reasonList(manualRegularisationReasons)} OR
    ${reasonCode} IN ${reasonList(manualRegularisationReasons)})`;
  const leave = `(${reason} IN ${reasonList(leaveRegularisationReasons)} OR
    ${reasonCode} IN ${reasonList(leaveRegularisationReasons)})`;
  const hasReason = `((${reason} NOT IN ('','none','null')) OR
    (${reasonCode} NOT IN ('','none','null')))`;
  return {
    reason,
    reasonCode,
    manual,
    leave,
    system: `(${hasReason} AND NOT ${manual} AND NOT ${leave})`,
  };
}
export function metricPolicy(input = {}) {
  const criticalBacklog=Number(input.criticalBacklog ?? 3);
  const anomalyDistanceMeters=Number(input.anomalyDistanceMeters ?? 500);
  if(!Number.isInteger(criticalBacklog)||criticalBacklog<1||criticalBacklog>10000||
      !Number.isFinite(anomalyDistanceMeters)||anomalyDistanceMeters<1||anomalyDistanceMeters>100000)
    throw new Error('Invalid metric policy');
  return {criticalBacklog,anomalyDistanceMeters};
}
export function queries(filter, policyInput = {}) {
  const policy=metricPolicy(policyInput);
  const where = predicates(filter);
  const activityWhere = activityPredicates(filter);
  const p = `FROM punch_fact p JOIN raw_users u USING (employee_id) ${where}`;
  const a = `FROM raw_activity a JOIN raw_users u USING (employee_id) ${activityWhere}`;
  const fReasons = reasonClassification('f');
  return {
    summary: `WITH filtered AS (SELECT p.* ${p})
       SELECT count(*) AS punchCount,
       count(DISTINCT employee_id) AS observedEmployees,
       count(*) FILTER (WHERE status='Pending') AS pendingCount,
       count(*) FILTER (WHERE status='Pending') AS pendingEntries,
       count(*) FILTER (WHERE status='Rejected') AS rejectedCount,
       count(*) FILTER (WHERE status='Rejected') AS rejectedEntries,
       count(*) FILTER (WHERE status IN ('Approved','System Approved')) AS approvedCount,
       count(*) FILTER (WHERE status <> 'Rejected' AND punch_type='Punch In') AS punchIns,
       count(*) FILTER (WHERE status <> 'Rejected' AND punch_type='Punch Out') AS punchOuts,
       count(DISTINCT employee_id) FILTER (WHERE status <> 'Rejected' AND punch_type='Punch In') AS presentEmployees,
       count(DISTINCT (employee_id,date)) FILTER (WHERE status <> 'Rejected' AND punch_type='Punch In') AS presentEmployeeDays,
       count(*) FILTER (WHERE punch_type='Full Day' AND ${fReasons.leave}
          AND status='Approved') AS approvedLeave,
       count(*) FILTER (WHERE punch_type='Full Day' AND ${fReasons.leave}
          AND status='Approved') AS approvedLeaves,
       count(*) FILTER (WHERE punch_type='Full Day' AND ${fReasons.leave}
          AND status='Pending') AS pendingLeaves,
       count(*) FILTER (WHERE punch_type='Full Day' AND status='Pending') AS potentialLeave,
       count(*) FILTER (WHERE punch_type='Full Day' AND status='Rejected') AS rejectedFullDay,
       count(*) FILTER (WHERE ${fReasons.system}) AS systemFlaggedEntries,
       count(*) FILTER (WHERE status IN ('Approved','System Approved')
          AND (reason IS NULL OR trim(reason)='' OR lower(trim(reason))='none')) AS cleanPunchCount,
       count(*) FILTER (WHERE lower(reason) LIKE '%face verified using otp%') AS otpFallbackCount,
       count(*) FILTER (WHERE lower(reason) LIKE '%outside%'
          OR lower(reason) LIKE '%backlog%' OR lower(reason) LIKE '%shift hours%'
          OR lower(reason) LIKE '%window%' OR lower(reason) LIKE '%duration less%') AS hygieneFlags,
       (SELECT count(*) FROM (SELECT employee_id FROM filtered GROUP BY employee_id
         HAVING count(*) FILTER (WHERE status IN ('Pending','Rejected')) >= ${policy.criticalBacklog})) AS criticalEmployees
       FROM filtered f`,
    activitySummary: `SELECT count(*) AS activityCount,
       count(*) FILTER (WHERE try_cast(a.distance_m AS DOUBLE) > ${policy.anomalyDistanceMeters}) AS outlierEvents,
       count(DISTINCT a.employee_id) FILTER
         (WHERE try_cast(a.distance_m AS DOUBLE) > ${policy.anomalyDistanceMeters}) AS outlierEmployees
       ${a}`,
    trend: `SELECT p.date AS date, count(*) AS punches,
       count(*) FILTER (WHERE p.status='Pending') AS pending,
       count(*) FILTER (WHERE p.status='Rejected') AS rejected,
       count(*) FILTER (WHERE p.status='Approved') AS approved,
       count(*) FILTER (WHERE p.status='System Approved') AS systemApproved
       ${p} GROUP BY p.date ORDER BY p.date`,
    team: `SELECT u.employee_id AS employeeId, u.name AS name, u.status AS employeeStatus,
       count(*) AS punches, count(*) FILTER (WHERE p.status='Pending') AS pending,
       count(*) FILTER (WHERE p.status='Rejected') AS rejected,
       count(DISTINCT p.location_id) AS observedLocations
       ${p} GROUP BY u.employee_id,u.name,u.status ORDER BY u.name`,
    approvals: `SELECT u.employee_id AS employeeId,u.name AS name,
       count(*) AS pending, min(p.timestamp) AS oldestAt
       ${p} ${where ? 'AND' : 'WHERE'} p.status='Pending'
       GROUP BY u.employee_id,u.name ORDER BY u.name`,
    leaves: `SELECT p.punch_id AS id,u.employee_id AS employeeId,u.name,
       p.date,p.timestamp,p.status,p.reason,p.punch_type AS punchType,
       l.name AS locationName,p.location_id AS locationId,
       try_cast(p.latitude AS DOUBLE) AS latitude,try_cast(p.longitude AS DOUBLE) AS longitude
       FROM punch_fact p JOIN raw_users u USING(employee_id)
       LEFT JOIN raw_locations l ON l.location_id=p.location_id ${where}
       ${where ? 'AND' : 'WHERE'} p.punch_type='Full Day'
         AND (p.status IN ('Pending','Rejected') OR lower(p.reason) LIKE '%leave%')
       ORDER BY p.date DESC,u.name,p.timestamp DESC`,
    anomalies: `WITH flagged AS (
       SELECT u.employee_id AS employeeId,u.name,'rejected' AS rule,
         count(*) AS eventCount,max(p.date) AS latestDate
       ${p} ${where ? 'AND' : 'WHERE'} p.status='Rejected'
       GROUP BY u.employee_id,u.name
       UNION ALL
       SELECT u.employee_id,u.name,'outside' AS rule,count(*),max(p.date)
       ${p} ${where ? 'AND' : 'WHERE'} lower(p.reason) LIKE '%outside%'
       GROUP BY u.employee_id,u.name
       UNION ALL
       SELECT u.employee_id,u.name,'backlog' AS rule,count(*),max(p.date)
       ${p} ${where ? 'AND' : 'WHERE'} p.status IN ('Pending','Rejected')
       GROUP BY u.employee_id,u.name HAVING count(*) >= ${policy.criticalBacklog}
       UNION ALL
       SELECT u.employee_id,u.name,'distance' AS rule,count(*),max(left(a.timestamp,10))
       ${a} ${activityWhere ? 'AND' : 'WHERE'} try_cast(a.distance_m AS DOUBLE) > ${policy.anomalyDistanceMeters}
       GROUP BY u.employee_id,u.name)
       SELECT * FROM flagged ORDER BY latestDate DESC,eventCount DESC,name`,
    locations: `WITH observed AS (
       SELECT p.location_id,count(*) AS punches,count(DISTINCT p.employee_id) AS employees
       ${p} GROUP BY p.location_id), assigned AS (
       SELECT l.location_id,count(*) AS assignedStaff FROM raw_locations l
       JOIN raw_users u ON list_contains(string_split(replace(u.office,' ',''),','),l.location_id)
       ${filter.employees?.length ? `WHERE u.employee_id IN (${filter.employees.map(quote).join(',')})` : ''}
       ${filter.employeeStatus && filter.employeeStatus !== 'all' ? `${filter.employees?.length ? 'AND':'WHERE'} lower(u.status)=${quote(filter.employeeStatus)}` : ''}
       GROUP BY l.location_id)
       SELECT l.location_id AS locationId,l.name AS name,
       try_cast(l.latitude AS DOUBLE) AS latitude,
       try_cast(l.longitude AS DOUBLE) AS longitude,
       coalesce(o.punches,0) AS punches,coalesce(o.employees,0) AS employees,
       coalesce(a.assignedStaff,0) AS assignedStaff
       FROM raw_locations l LEFT JOIN observed o USING(location_id)
       LEFT JOIN assigned a USING(location_id)
       WHERE o.punches > 0 OR a.assignedStaff > 0 ORDER BY l.location_id`,
    activity: `SELECT left(a.timestamp,10) AS date, count(*) AS events,
       count(*) FILTER (WHERE try_cast(a.distance_m AS DOUBLE) > ${policy.anomalyDistanceMeters}) AS outlierEvents,
       count(DISTINCT a.employee_id) AS employees,
       round(avg(try_cast(a.distance_m AS DOUBLE)),1) AS meanDistance
       ${a} GROUP BY left(a.timestamp,10) ORDER BY date`,
    activityPoints: `SELECT a.activity_id AS id,a.employee_id AS employeeId,u.name,
       a.timestamp,left(a.timestamp,10) AS date,
       try_cast(a.latitude AS DOUBLE) AS latitude,try_cast(a.longitude AS DOUBLE) AS longitude,
       try_cast(a.distance_m AS DOUBLE) AS distanceMeters,
       a.nearest_location_id AS locationId,l.name AS locationName,
       try_cast(l.latitude AS DOUBLE) AS siteLatitude,
       try_cast(l.longitude AS DOUBLE) AS siteLongitude
       FROM raw_activity a JOIN raw_users u USING(employee_id)
       LEFT JOIN raw_locations l ON l.location_id=a.nearest_location_id ${activityWhere}
       ORDER BY a.timestamp,a.activity_id`,
    punchPoints: `SELECT p.punch_id AS id,p.employee_id AS employeeId,u.name,
       p.date,p.timestamp,p.punch_type AS punchType,p.status,p.reason,
       p.reason_code AS reasonCode,p.location_id AS locationId,
       l.name AS locationName,
       try_cast(p.latitude AS DOUBLE) AS latitude,
       try_cast(p.longitude AS DOUBLE) AS longitude
       FROM punch_fact p JOIN raw_users u USING(employee_id)
       LEFT JOIN raw_locations l ON l.location_id=p.location_id ${where}
       ${where ? 'AND' : 'WHERE'} try_cast(p.latitude AS DOUBLE) BETWEEN -90 AND 90
         AND try_cast(p.longitude AS DOUBLE) BETWEEN -180 AND 180
         AND NOT (try_cast(p.latitude AS DOUBLE)=0
           AND try_cast(p.longitude AS DOUBLE)=0)
       ORDER BY p.date,p.timestamp,p.punch_id`,
    facets: `SELECT u.employee_id AS employeeId,u.name AS name,u.status AS employeeStatus,
       u.office AS assignedOffices FROM raw_users u ORDER BY u.name`,
    locationOptions: `SELECT l.location_id AS locationId,l.name FROM raw_locations l
      WHERE l.location_id IN (SELECT DISTINCT p.location_id FROM punch_fact p
        JOIN raw_users u USING(employee_id) ${predicates({...filter,locations:[]})})
      OR EXISTS (SELECT 1 FROM raw_users u WHERE
        list_contains(string_split(replace(u.office,' ',''),','),l.location_id)
        ${filter.employees?.length ? `AND u.employee_id IN (${filter.employees.map(quote).join(',')})` : ''}
        ${filter.employeeStatus && filter.employeeStatus !== 'all' ? `AND lower(u.status)=${quote(filter.employeeStatus)}` : ''})
      ORDER BY l.location_id`,
    statusOptions: `SELECT DISTINCT status FROM raw_punches WHERE status IS NOT NULL ORDER BY status`,
    range: `SELECT min(date) AS firstDate,max(date) AS lastDate FROM raw_punches`,
    observedLocations: `SELECT DISTINCT p.location_id AS locationId ${p}
       ${where ? 'AND' : 'WHERE'} p.location_id IS NOT NULL ORDER BY locationId`,
  };
}
export function detailsQuery(filter, kind, id, policyInput = {}) {
  if (kind === 'widget') {
    const q=queries(filter,policyInput);
    const exports={trend:q.trend,approvals:q.approvals,team:q.team,
      locations:q.locations,anomalies:q.anomalies,leave:q.leaves,
      activity:q.punchPoints};
    if (!Object.hasOwn(exports,id)) throw new Error('Invalid widget export');
    return exports[id];
  }
  if (kind === 'metric') {
    const where=predicates(filter), suffix=where?'AND':'WHERE';
    const p=`FROM punch_fact p JOIN raw_users u USING(employee_id)
      LEFT JOIN raw_locations l ON l.location_id=p.location_id ${where}`;
    const fields=`p.punch_id AS id,p.employee_id AS employeeId,u.name,p.date,p.timestamp,
      p.punch_type AS punchType,p.status,p.reason,p.reason_code AS reasonCode,
      l.name AS locationName,p.location_id AS locationId`;
    const reasons=reasonClassification('p');
    const clean=`p.status IN ('Approved','System Approved') AND
      (p.reason IS NULL OR trim(p.reason)='' OR lower(trim(p.reason))='none')`;
    const flag=`lower(p.reason) LIKE '%outside%' OR lower(p.reason) LIKE '%backlog%' OR
      lower(p.reason) LIKE '%shift hours%' OR lower(p.reason) LIKE '%window%' OR
      lower(p.reason) LIKE '%duration less%'`;
    const leave=`p.punch_type='Full Day' AND ${reasons.leave}`;
    const conditions={
      presentDays:"p.punch_type='Punch In' AND p.status <> 'Rejected'",
      punchIns:"p.punch_type='Punch In' AND p.status <> 'Rejected'",
      punchOuts:"p.punch_type='Punch Out' AND p.status <> 'Rejected'",
      pendingEntries:"p.status='Pending'",
      rejectedEntries:"p.status='Rejected'",
      pendingLeaves:`${leave} AND p.status='Pending'`,
      approvedLeaves:`${leave} AND p.status='Approved'`,
      systemFlaggedEntries:reasons.system,
      pending:"p.status='Pending'",
      approvedLeave:`${leave} AND p.status='Approved'`,
      potentialLeave:"p.punch_type='Full Day' AND p.status='Pending'",
      hygiene:`(${flag})`,rejected:"p.status='Rejected'"};
    if (id==='presentDays') return `SELECT p.employee_id AS employeeId,u.name,p.date,
      count(*) AS punchIns ${p} ${suffix} ${conditions[id]}
      GROUP BY p.employee_id,u.name,p.date ORDER BY p.date DESC,u.name`;
    if (id==='cleanRate' || id==='otpRate') {
      const expression=id==='cleanRate'?clean:"lower(p.reason) LIKE '%face verified using otp%'";
      return `SELECT ${fields},(${expression}) AS qualifies ${p} ORDER BY p.date DESC,p.timestamp DESC`;
    }
    if (Object.hasOwn(conditions,id)) return `SELECT ${fields} ${p} ${suffix} ${conditions[id]}
      ORDER BY p.date DESC,p.timestamp DESC`;
    if (id==='criticalEmployees') return `SELECT p.employee_id AS employeeId,u.name,
      count(*) FILTER (WHERE p.status IN ('Pending','Rejected')) AS reviewPunches,
      count(*) FILTER (WHERE p.status='Pending') AS pending,
      count(*) FILTER (WHERE p.status='Rejected') AS rejected
      FROM punch_fact p JOIN raw_users u USING(employee_id) ${where}
      GROUP BY p.employee_id,u.name HAVING reviewPunches >= ${metricPolicy(policyInput).criticalBacklog}
      ORDER BY reviewPunches DESC,u.name`;
    if (id==='anomalyHits') {
      const threshold=metricPolicy(policyInput).criticalBacklog;
      const distance=metricPolicy(policyInput).anomalyDistanceMeters;
      const activityWhere=activityPredicates(filter);
      return `WITH punch_events AS (SELECT ${fields} ${p}),
      backlog AS (SELECT employeeId FROM punch_events
        WHERE status IN ('Pending','Rejected') GROUP BY employeeId HAVING count(*) >= ${threshold})
      SELECT 'rejected' AS rule,* FROM punch_events WHERE status='Rejected'
      UNION ALL SELECT 'outside' AS rule,* FROM punch_events WHERE lower(reason) LIKE '%outside%'
      UNION ALL SELECT 'backlog' AS rule,* FROM punch_events
        WHERE employeeId IN (SELECT employeeId FROM backlog) AND status IN ('Pending','Rejected')
      UNION ALL SELECT 'distance' AS rule,a.activity_id AS id,a.employee_id AS employeeId,
        u.name,left(a.timestamp,10) AS date,a.timestamp,'Activity' AS punchType,
        NULL AS status,concat(a.distance_m,' m from site') AS reason,
        NULL AS reasonCode,
        l.name AS locationName,a.nearest_location_id AS locationId
        FROM raw_activity a JOIN raw_users u USING(employee_id)
        LEFT JOIN raw_locations l ON l.location_id=a.nearest_location_id ${activityWhere}
        ${activityWhere?'AND':'WHERE'} try_cast(a.distance_m AS DOUBLE) > ${distance}
      ORDER BY date DESC,timestamp DESC`;
    }
    throw new Error('Invalid metric export');
  }
  if (kind === 'punchHistory') {
    return `SELECT status,timestamp FROM raw_approvals WHERE punch_id=${quote(id)}
      ORDER BY timestamp DESC`;
  }
  if (kind === 'approval') {
    const base = predicates({...filter, employees: [id]});
    return `SELECT p.punch_id AS id,p.date,p.timestamp,p.punch_type AS punchType,
      p.status,p.reason,p.location_id AS locationId,
      try_cast(p.latitude AS DOUBLE) AS latitude,
      try_cast(p.longitude AS DOUBLE) AS longitude FROM punch_fact p
      JOIN raw_users u USING (employee_id) ${base} AND p.status='Pending'
      ORDER BY p.timestamp DESC LIMIT 100 OFFSET 0`;
  }
  if (kind === 'location') {
    const base = predicates({...filter, locations: [id]});
    return `SELECT p.punch_id AS id,u.employee_id AS employeeId,u.name,
      p.date,p.timestamp,p.punch_type AS punchType,p.status,p.reason,
      try_cast(p.latitude AS DOUBLE) AS latitude,
      try_cast(p.longitude AS DOUBLE) AS longitude
      FROM punch_fact p JOIN raw_users u USING (employee_id) ${base}
      ORDER BY u.name,p.timestamp DESC LIMIT 200 OFFSET 0`;
  }
  if (kind === 'employee') {
    // Detail is an audit of the scoped employee and date, including every
    // source status. A dashboard status chip must not conceal rejected rows.
    const base = predicates({...filter, employees: [id],statuses:[],employeeStatus:'all'});
    return `SELECT p.punch_id AS id,p.date,p.timestamp,p.punch_type AS punchType,
      p.status,p.reason,p.location_id AS locationId,l.name AS locationName,
      try_cast(p.latitude AS DOUBLE) AS latitude,
      try_cast(p.longitude AS DOUBLE) AS longitude
      FROM punch_fact p JOIN raw_users u USING(employee_id)
      LEFT JOIN raw_locations l ON l.location_id=p.location_id ${base}
      ORDER BY p.date DESC,p.timestamp DESC,p.punch_id`;
  }
  if (kind === 'locationEmployees' || kind === 'assigned') {
    const assigned=`list_contains(string_split(replace(ro.office,' ',''),','),${quote(id)})`;
    const conditions=[`(${assigned} OR coalesce(o.punches,0)>0)`];
    if (filter.employees?.length) conditions.push(`ro.employee_id IN (${filter.employees.map(quote).join(',')})`);
    if (filter.employeeStatus && filter.employeeStatus !== 'all') conditions.push(`lower(ro.status)=${quote(filter.employeeStatus)}`);
    const scoped=predicates({...filter,locations:[id]});
    return `WITH observed AS (SELECT p.employee_id,count(*) AS punches
      FROM punch_fact p JOIN raw_users u USING(employee_id) ${scoped}
      GROUP BY p.employee_id)
      SELECT ro.employee_id AS employeeId,ro.name,ro.status,
        coalesce(o.punches,0) AS punches,
        CASE WHEN ${assigned} THEN 'Assigned' ELSE 'Observed, not assigned' END AS assignment
      FROM raw_users ro LEFT JOIN observed o ON o.employee_id=ro.employee_id
      WHERE ${conditions.join(' AND ')} ORDER BY assignment,ro.name`;
  }
  if (kind === 'locationEmployee') {
    const pair=JSON.parse(id);
    if(typeof pair.locationId!=='string'||typeof pair.employeeId!=='string')
      throw new Error('Invalid location employee key');
    const base=predicates({...filter,locations:[pair.locationId],employees:[pair.employeeId]});
    return `SELECT p.punch_id AS id,p.date,p.timestamp,p.punch_type AS punchType,
      p.status,p.reason,p.location_id AS locationId,l.name AS locationName,
      try_cast(p.latitude AS DOUBLE) AS latitude,
      try_cast(p.longitude AS DOUBLE) AS longitude
      FROM punch_fact p JOIN raw_users u USING(employee_id)
      LEFT JOIN raw_locations l ON l.location_id=p.location_id ${base}
      ORDER BY p.date DESC,p.timestamp DESC,p.punch_id`;
  }
  if (kind === 'anomaly') {
    const key=JSON.parse(id);
    if(typeof key.employeeId!=='string'||!['rejected','outside','backlog','distance'].includes(key.rule))
      throw new Error('Invalid anomaly key');
    if(key.rule==='distance') {
      const base=activityPredicates({...filter,employees:[key.employeeId]});
      return `SELECT a.activity_id AS id,left(a.timestamp,10) AS date,a.timestamp,
        try_cast(a.distance_m AS DOUBLE) AS distanceMeters,
        l.name AS locationName FROM raw_activity a JOIN raw_users u USING(employee_id)
        LEFT JOIN raw_locations l ON l.location_id=a.nearest_location_id ${base}
        ${base ? 'AND' : 'WHERE'} try_cast(a.distance_m AS DOUBLE) > ${metricPolicy(policyInput).anomalyDistanceMeters}
        ORDER BY a.timestamp DESC`;
    }
    const base=predicates({...filter,employees:[key.employeeId]});
    const condition=key.rule==='rejected' ? "p.status='Rejected'" :
      key.rule==='outside' ? "lower(p.reason) LIKE '%outside%'" :
        "p.status IN ('Pending','Rejected')";
    return `SELECT p.punch_id AS id,p.date,p.timestamp,p.punch_type AS punchType,
      p.status,p.reason,l.name AS locationName,p.location_id AS locationId,
      try_cast(p.latitude AS DOUBLE) AS latitude,try_cast(p.longitude AS DOUBLE) AS longitude
      FROM punch_fact p JOIN raw_users u USING(employee_id)
      LEFT JOIN raw_locations l ON l.location_id=p.location_id ${base}
      ${base ? 'AND' : 'WHERE'} ${condition} ORDER BY p.date DESC,p.timestamp DESC`;
  }
  throw new Error('Invalid detail type');
}
