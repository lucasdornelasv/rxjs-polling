import {
	Observable,
	Subject,
	Subscription,
	asyncScheduler,
	defer,
	finalize,
	from,
	mergeMap,
	of,
	retry,
	subscribeOn,
	takeLast,
	takeUntil,
	throwError,
} from 'rxjs';

export enum JobStateType {
	Sending,
	Created,
	Finished,
	Destroyed,
}

export enum JobStatusType {
	Running,
	Success,
	Failed,
}

export interface JobStatusInfo<T = any> {
	status: JobStatusType;
	error?: any;
	data?: T;
}

type AsyncReturn<T> = T | Observable<T> | Promise<T>;

function resolveAsyncReturn<T>(
	res: AsyncReturn<T>,
	shouldThrowError = false
): Observable<T> {
	if (res instanceof Promise) {
		res = from(res);
	}

	if (!(res instanceof Observable)) {
		res = of(res);
	}

	if (shouldThrowError) {
		res = res.pipe(
			mergeMap((x) => {
				return throwError(() => x);
			})
		);
	}

	return res;
}

export interface IPollingOptions<T, I, R = JobStatusInfo<I>> {
	jobFactory?: () => AsyncReturn<T>;
	checkJobFn: (jobData: T) => AsyncReturn<JobStatusInfo<I>>;
	doFinished?: (info: JobStatusInfo<I>, jobData: T) => AsyncReturn<R>;
	doFailed?: (response: any, jobData: T) => AsyncReturn<any>;
	retryTimes?: number;
	initialCheckInterval?: number;
	checkInterval?: number;
}

export class RxPollingTask<T, I, R = I> {
	private _state: JobStateType = null;

	private set state(value) {
		if (this._state === value) {
			return;
		}

		this._state = value;
		this._jobStateSubject.next(value);
	}

	get state() {
		return this._state;
	}

	private _jobStatus: JobStatusInfo<I> = null;

	get jobStatus() {
		return this._jobStatus;
	}

	private _jobStateSubject = new Subject<JobStateType>();
	private _jobStatusSubject = new Subject<JobStatusInfo<I>>();

	get onJobEvent() {
		return this._jobStatusSubject.asObservable();
	}

	get onJobStatus() {
		return this._jobStatusSubject.asObservable();
	}

	get started() {
		return this.state !== null;
	}

	get created() {
		return this.state === JobStateType.Created;
	}

	get finished() {
		return this.state === JobStateType.Finished;
	}

	get destroyed() {
		return this.state === JobStateType.Destroyed;
	}

	private _destroySubject = new Subject<void>();

	constructor(private options: IPollingOptions<T, I, R>) {}

	submit(): Observable<R> {
		this._checkDestroyed();

		if (this.state !== null) {
			throw new Error('Task has started');
		}

		this.state = JobStateType.Sending;
		return defer(() => {
			this._checkDestroyed();

			if (this.state !== null && this.state !== JobStateType.Sending) {
				throw new Error('Task has started');
			}

			return resolveAsyncReturn(this.options.jobFactory?.()).pipe(
				mergeMap((jobData) => {
					this.state = JobStateType.Created;

					const checkInterval = this.options.checkInterval ?? 1000;

					return this._observeJob(
						jobData,
						this.options.initialCheckInterval ?? checkInterval,
						checkInterval
					).pipe(
						takeLast(1),
						mergeMap((jobStatus) => {
							if (
								jobStatus.status === JobStatusType.Success &&
								this.options.doFinished
							) {
								return resolveAsyncReturn(
									this.options.doFinished(jobStatus, jobData)
								);
							} else if (jobStatus.status === JobStatusType.Failed) {
								return resolveAsyncReturn(
									this.options.doFailed?.(jobStatus, jobData) ?? jobStatus,
									true
								);
							} else {
								return of(jobStatus as any);
							}
						})
					);
				}),
				finalize(() => {
					this._jobStateSubject.complete();
					this._jobStatusSubject.complete();
				})
			);
		}).pipe(takeUntil(this._destroySubject));
	}

	destroy() {
		if (!this.destroyed) {
			this.state = JobStateType.Destroyed;
			this._destroySubject.next();
			this._destroySubject.complete();

			this._jobStateSubject.complete();
			this._jobStatusSubject.complete();
		}
	}

	clone() {
		return new RxPollingTask(this.options);
	}

	private _checkDestroyed() {
		if (this.destroyed) {
			throw new Error('Task was destroyed');
		}
	}

	private _observeJob(
		jobData: T,
		initialCheckInterval: number,
		checkInterval: number
	) {
		return new Observable<JobStatusInfo<I>>((subscriber) => {
			let periodicSubscription: Subscription;

			subscriber.add(() => {
				periodicSubscription?.unsubscribe();
			});

			let firstExecution = true;
			let interval: number;

			const checkPeriodicStatus = () => {
				if (firstExecution) {
					firstExecution = false;
					interval = initialCheckInterval;
				} else {
					interval = checkInterval;
				}

				periodicSubscription?.unsubscribe();
				periodicSubscription = resolveAsyncReturn(
					this.options.checkJobFn(jobData)
				)
					.pipe(
						subscribeOn(asyncScheduler, interval),
						retry(this.options.retryTimes ?? 0)
					)
					.subscribe({
						next: (res) => {
							this._jobStatusSubject.next(res);
							subscriber.next(res);

							if (
								res?.status === JobStatusType.Success ||
								res?.status === JobStatusType.Failed
							) {
								this.state = JobStateType.Finished;

								subscriber.complete();
							} else {
								checkPeriodicStatus();
							}
						},
						error: (response) => {
							this._jobStatusSubject.next({
								status: JobStatusType.Failed,
								error: response,
							});

							this.state = JobStateType.Finished;

							subscriber.error(response);
						},
					});
			};

			checkPeriodicStatus();
		});
	}
}
