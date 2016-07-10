import React, { PropTypes } from 'react'
import classNames from 'classnames';

const Die = React.createClass({
	getDefaultProps() {
		return {
			num: 1
		}
	},
	render() {

		let href = 'one';
		switch(this.props.num){
			case 2:
				href = 'two';
				break;
			case 3:
				href = 'three';
				break;
			case 4:
				href = 'four';
				break;
			case 5:
				href = 'five';
				break;
			case 6:
				href = 'six';
				break;
		}
		href = '#dice--' + href;

		const svgPaths = <div className="dice"><svg viewBox="0 0 210 210"><use xlinkHref={href} x="0" y="0" /></svg></div>;

		return (
			<div className={classNames('die')}>
				{svgPaths}
			</div>
		)
	}
})

export default Die;
